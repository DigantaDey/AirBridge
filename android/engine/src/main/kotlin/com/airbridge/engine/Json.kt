package com.airbridge.engine

/**
 * Minimal dependency-free JSON parser/writer for the AirBridge protocol.
 *
 * The Android engine must run on a plain JVM (so it is unit-testable
 * headlessly) and on Android (where org.json exists but is Android-only) --
 * so it brings its own. Only what the protocol needs is supported: UTF-8
 * text, numbers (long + double), booleans, null, arrays, objects.
 */
sealed class JsonValue {
    object JsonNull : JsonValue() {
        override fun toString() = "null"
    }

    data class JsonBool(val value: Boolean) : JsonValue()

    data class JsonLong(val value: Long) : JsonValue()

    data class JsonDouble(val value: Double) : JsonValue()

    data class JsonStr(val value: String) : JsonValue()

    class JsonArr(val items: MutableList<JsonValue> = mutableListOf()) : JsonValue() {
        operator fun get(i: Int): JsonValue = items[i]
        val size: Int get() = items.size
        fun add(v: JsonValue): JsonArr = apply { items.add(v) }
    }

    class Obj(val map: MutableMap<String, JsonValue> = LinkedHashMap()) : JsonValue() {
        operator fun get(key: String): JsonValue? = map[key]
        fun has(key: String): Boolean = map.containsKey(key)
        fun put(key: String, v: JsonValue): Obj = apply { map[key] = v }
        fun put(key: String, v: String): Obj = put(key, JsonStr(v))
        fun put(key: String, v: Long): Obj = put(key, JsonLong(v))
        fun put(key: String, v: Int): Obj = put(key, JsonLong(v.toLong()))
        fun put(key: String, v: Boolean): Obj = put(key, JsonBool(v))
        fun putOpt(key: String, v: String?): Obj = apply { if (v != null) map[key] = JsonStr(v) }
        fun putOpt(key: String, v: Long?): Obj = apply { if (v != null) map[key] = JsonLong(v) }
    }

    fun asString(): String = (this as? JsonStr)?.value
        ?: throw JsonTypeException("expected string, got $this")

    fun asStringOrNull(): String? = (this as? JsonStr)?.value

    fun asLong(): Long = when (this) {
        is JsonLong -> value
        is JsonDouble -> value.toLong()
        else -> throw JsonTypeException("expected number, got $this")
    }

    fun asInt(): Int = asLong().toInt()

    fun asDouble(): Double = when (this) {
        is JsonDouble -> value
        is JsonLong -> value.toDouble()
        else -> throw JsonTypeException("expected number, got $this")
    }

    fun asBool(): Boolean = (this as? JsonBool)?.value
        ?: throw JsonTypeException("expected boolean, got $this")

    fun asObj(): Obj = this as? Obj ?: throw JsonTypeException("expected object, got $this")

    fun asArr(): JsonArr = this as? JsonArr ?: throw JsonTypeException("expected array, got $this")

    fun optObj(key: String): Obj? = (this as? Obj)?.map?.get(key) as? Obj

    fun optStr(key: String): String? = (this as? Obj)?.map?.get(key)?.asStringOrNull()

    fun optLong(key: String): Long? = (this as? Obj)?.map?.get(key)?.let {
        when (it) {
            is JsonLong -> it.value
            is JsonDouble -> it.value.toLong()
            else -> null
        }
    }

    fun optInt(key: String): Int? = optLong(key)?.toInt()

    fun optBool(key: String): Boolean? = ((this as? Obj)?.map?.get(key) as? JsonBool)?.value

    fun optArr(key: String): JsonArr? = (this as? Obj)?.map?.get(key) as? JsonArr

    fun toJsonString(): String {
        val sb = StringBuilder()
        writeJson(this, sb)
        return sb.toString()
    }

    companion object {
        fun parse(text: String): JsonValue = JsonParser(text).parseDocument()
        fun parseObject(text: String): Obj = parse(text).asObj()
    }
}

class JsonTypeException(message: String) : RuntimeException(message)

private fun writeJson(v: JsonValue, sb: StringBuilder) {
    when (v) {
        is JsonValue.JsonNull -> sb.append("null")
        is JsonValue.JsonBool -> sb.append(if (v.value) "true" else "false")
        is JsonValue.JsonLong -> sb.append(v.value.toString())
        is JsonValue.JsonDouble -> {
            if (v.value.isNaN() || v.value.isInfinite()) sb.append("null")
            else sb.append(v.value.toString())
        }
        is JsonValue.JsonStr -> writeJsonString(v.value, sb)
        is JsonValue.JsonArr -> {
            sb.append('[')
            for ((i, item) in v.items.withIndex()) {
                if (i > 0) sb.append(',')
                writeJson(item, sb)
            }
            sb.append(']')
        }
        is JsonValue.Obj -> {
            sb.append('{')
            var first = true
            for ((k, item) in v.map) {
                if (!first) sb.append(',')
                first = false
                writeJsonString(k, sb)
                sb.append(':')
                writeJson(item, sb)
            }
            sb.append('}')
        }
    }
}

private fun writeJsonString(s: String, sb: StringBuilder) {
    sb.append('"')
    for (c in s) {
        when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            '\b' -> sb.append("\\b")
            else -> when {
                c.code == 12 -> sb.append("\\f") // form feed
                c.code < 0x20 -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
        }
    }
    sb.append('"')
}

/** Recursive-descent parser; protocol payloads are small so depth is bounded. */
private class JsonParser(private val text: String) {
    private var pos = 0

    fun parseDocument(): JsonValue {
        skipWs()
        val v = parseValue()
        skipWs()
        if (pos != text.length) fail("trailing data at $pos")
        return v
    }

    private fun parseValue(): JsonValue {
        if (pos >= text.length) fail("unexpected end")
        return when (text[pos]) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> JsonValue.JsonStr(parseString())
            't' -> literal("true", JsonValue.JsonBool(true))
            'f' -> literal("false", JsonValue.JsonBool(false))
            'n' -> literal("null", JsonValue.JsonNull)
            else -> parseNumber()
        }
    }

    private fun literal(lit: String, value: JsonValue): JsonValue {
        if (!text.startsWith(lit, pos)) fail("bad literal at $pos")
        pos += lit.length
        return value
    }

    private fun parseObject(): JsonValue.Obj {
        pos++ // {
        val obj = JsonValue.Obj()
        skipWs()
        if (peek() == '}') {
            pos++
            return obj
        }
        while (true) {
            skipWs()
            if (peek() != '"') fail("expected key at $pos")
            val key = parseString()
            skipWs()
            if (peek() != ':') fail("expected ':' at $pos")
            pos++
            skipWs()
            obj.map[key] = parseValue()
            skipWs()
            when (peek()) {
                ',' -> pos++
                '}' -> {
                    pos++
                    return obj
                }
                else -> fail("expected ',' or '}' at $pos")
            }
        }
    }

    private fun parseArray(): JsonValue.JsonArr {
        pos++ // [
        val arr = JsonValue.JsonArr()
        skipWs()
        if (peek() == ']') {
            pos++
            return arr
        }
        while (true) {
            skipWs()
            arr.items.add(parseValue())
            skipWs()
            when (peek()) {
                ',' -> pos++
                ']' -> {
                    pos++
                    return arr
                }
                else -> fail("expected ',' or ']' at $pos")
            }
        }
    }

    private fun parseString(): String {
        pos++ // opening quote
        val sb = StringBuilder()
        while (true) {
            if (pos >= text.length) fail("unterminated string")
            val c = text[pos++]
            when {
                c == '"' -> return sb.toString()
                c == '\\' -> {
                    if (pos >= text.length) fail("bad escape")
                    when (val e = text[pos++]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append(12.toChar()) // form feed
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (pos + 4 > text.length) fail("bad \\u escape")
                            val hex = text.substring(pos, pos + 4)
                            pos += 4
                            sb.append(hex.toInt(16).toChar())
                        }
                        else -> fail("bad escape \\$e")
                    }
                }
                c.code < 0x20 -> fail("raw control char in string")
                else -> sb.append(c)
            }
        }
    }

    private fun parseNumber(): JsonValue {
        val start = pos
        if (peek() == '-') pos++
        while (pos < text.length && (text[pos].isDigit() || text[pos] in ".eE+-")) pos++
        val raw = text.substring(start, pos)
        if (raw.isEmpty()) fail("bad number at $start")
        return if (raw.any { it in ".eE" }) {
            JsonValue.JsonDouble(raw.toDouble())
        } else {
            JsonValue.JsonLong(raw.toLong())
        }
    }

    private fun peek(): Char {
        if (pos >= text.length) fail("unexpected end")
        return text[pos]
    }

    private fun skipWs() {
        while (pos < text.length && text[pos].let {
                it == ' ' || it == '\n' || it == '\r' || it == '\t'
            }
        ) pos++
    }

    private fun fail(msg: String): Nothing = throw JsonTypeException("JSON parse error: $msg")
}
