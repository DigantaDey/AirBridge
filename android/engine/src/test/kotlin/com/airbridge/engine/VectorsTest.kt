package com.airbridge.engine

import java.io.File
import javax.crypto.KeyAgreement
import kotlin.system.exitProcess

private var passed = 0
private var failed = 0

private fun check(name: String, ok: Boolean, detail: String = "") {
    if (ok) {
        passed++
    } else {
        failed++
        println("FAIL $name" + if (detail.isNotEmpty()) " -> $detail" else "")
    }
}

/**
 * Cross-implementation vector test: every expectation in vectors.json was
 * produced by the real TypeScript reference implementation
 * (scripts/gen-test-vectors.ts). Run:
 *
 *   kotlinc engine+test -> java -cp out com.airbridge.engine.VectorsTestKt vectors.json
 */
fun main(args: Array<String>) {
    val path = args.getOrNull(0)
        ?: "android/engine/src/test/resources/vectors.json"
    val root = JsonValue.parseObject(File(path).readText())

    // ---------------------------------------------------------------- identities
    root.optArr("identities")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val priv = AirCrypto.importPrivateKey(Base64Url.decode(o.optStr("pkcs8")!!))
        val peerPub = AirCrypto.importRawPublicKeyB64(o.optStr("peerPub")!!)
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(priv)
        ka.doPhase(peerPub, true)
        val shared = ka.generateSecret()
        val expected = Base64Url.decode(o.optStr("sharedB64")!!)
        check(
            "identity[$i].ecdh-shared-secret",
            shared.contentEquals(expected),
            "got ${shared.size}B/${Base64Url.encode(shared)} want ${expected.size}B/${o.optStr("sharedB64")}",
        )
    }
    run {
        val kp = AirCrypto.generateIdentityKeyPair()
        val raw = AirCrypto.rawPublicKey(kp.publicKey as java.security.interfaces.ECPublicKey)
        check(
            "identity.generated-format",
            raw.size == 65 && raw[0] == 0x04.toByte() &&
                kp.publicKeyB64.length <= 128 &&
                Base64Url.decode(kp.publicKeyB64).contentEquals(raw),
            "raw=${raw.size}B b64len=${kp.publicKeyB64.length}",
        )
    }

    // ---------------------------------------------------------------- sessions
    root.optArr("sessions")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val priv = AirCrypto.importPrivateKey(Base64Url.decode(o.optStr("pkcs8")!!))
        val session = AirCrypto.derivePeerSession(
            priv,
            o.optStr("pubA")!!,
            o.optStr("pubB")!!,
        )
        check("session[$i].sas", session.sasCode == o.optStr("sas"),
            "got ${session.sasCode} want ${o.optStr("sas")}")
        check("session[$i].fingerprint", session.fingerprintHex == o.optStr("fingerprint"),
            "got ${session.fingerprintHex} want ${o.optStr("fingerprint")}")
        val wantKey = Base64Url.decode(o.optStr("hkdfKeyB64")!!)
        check(
            "session[$i].hkdf-key",
            session.rawAesKey.contentEquals(wantKey),
            "got ${Base64Url.encode(session.rawAesKey)} want ${o.optStr("hkdfKeyB64")}",
        )
    }

    // ---------------------------------------------------------------- envelopes
    root.optArr("envelopes")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val priv = AirCrypto.importPrivateKey(Base64Url.decode(o.optStr("pkcs8")!!))
        val session = AirCrypto.derivePeerSession(priv, o.optStr("pubA")!!, o.optStr("pubB")!!)
        val plain = o.optStr("plaintext")!!.toByteArray(Charsets.UTF_8)
        // 1. decrypt the TS-sealed envelope with the locally derived key
        val decrypted = AirCrypto.decryptControlPayload(
            session.aesKey,
            Base64Url.decode(o.optStr("ivB64")!!),
            Base64Url.decode(o.optStr("ciphertextB64")!!),
        )
        check("envelope[$i].ts-decrypt", decrypted.contentEquals(plain),
            "got ${decrypted.toString(Charsets.UTF_8).take(80)}")
        // 2. seal locally and round-trip
        val sealed = AirCrypto.encryptControlPayload(session.aesKey, plain)
        val back = AirCrypto.decryptControlPayload(session.aesKey, sealed.iv, sealed.ciphertext)
        check("envelope[$i].roundtrip", back.contentEquals(plain))
    }

    // ---------------------------------------------------------------- chunks
    root.optArr("chunks")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val priv = AirCrypto.importPrivateKey(Base64Url.decode(o.optStr("pkcs8")!!))
        val session = AirCrypto.derivePeerSession(priv, o.optStr("pubA")!!, o.optStr("pubB")!!)
        val plain = Base64Url.decode(o.optStr("plainB64")!!)
        val iv = Base64Url.decode(o.optStr("ivB64")!!)
        val ct = Base64Url.decode(o.optStr("ciphertextB64")!!)
        val fileIndex = o.optLong("fileIndex")!!.toInt()
        val chunkIndex = o.optLong("chunkIndex")!!.toInt()

        // IV layout: 4 random + fileIndex BE u32 + chunkIndex BE u32
        fun be(b: ByteArray, off: Int): Long =
            ((b[off].toLong() and 0xff) shl 24) or ((b[off + 1].toLong() and 0xff) shl 16) or
                ((b[off + 2].toLong() and 0xff) shl 8) or (b[off + 3].toLong() and 0xff)
        check("chunk[$i].iv-layout", iv.size == 12 && be(iv, 4) == fileIndex.toLong() &&
            be(iv, 8) == chunkIndex.toLong(), "iv=${Base64Url.encode(iv)}")

        val decrypted = AirCrypto.decryptBinaryChunk(session.aesKey, iv, ct)
        check("chunk[$i].ts-decrypt", decrypted.contentEquals(plain))

        val (ourIv, ourCt) = AirCrypto.encryptBinaryChunk(session.aesKey, plain, fileIndex, chunkIndex)
        check("chunk[$i].iv-layout-local", be(ourIv, 4) == fileIndex.toLong() &&
            be(ourIv, 8) == chunkIndex.toLong())
        val roundtrip = AirCrypto.decryptBinaryChunk(session.aesKey, ourIv, ourCt)
        check("chunk[$i].roundtrip", roundtrip.contentEquals(plain))
    }

    // ---------------------------------------------------------------- frame codecs
    root.optArr("chunkFrames")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val frame = Frames.EncryptedChunkFrame(
            transferId = o.optStr("transferId")!!,
            fileIndex = o.optLong("fileIndex")!!.toInt(),
            chunkIndex = o.optLong("chunkIndex")!!.toInt(),
            iv = Base64Url.decode(o.optStr("ivB64")!!),
            ciphertext = Base64Url.decode(o.optStr("ciphertextB64")!!),
        )
        val want = Base64Url.decode(o.optStr("frameB64")!!)
        val got = Frames.encodeEncryptedChunkFrame(frame)
        check("chunkFrame[$i].encode", got.contentEquals(want),
            "got ${got.size}B want ${want.size}B")
        val decoded = Frames.decodeEncryptedChunkFrame(want)
        check(
            "chunkFrame[$i].decode",
            decoded.transferId == frame.transferId && decoded.fileIndex == frame.fileIndex &&
                decoded.chunkIndex == frame.chunkIndex &&
                decoded.iv.contentEquals(frame.iv) &&
                decoded.ciphertext.contentEquals(frame.ciphertext),
        )
    }

    root.optArr("routedFrames")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val payload = Base64Url.decode(o.optStr("payloadB64")!!)
        val want = Base64Url.decode(o.optStr("frameB64")!!)
        val got = Frames.wrapRoutedRelayFrame(o.optStr("target")!!, o.optStr("source")!!, payload)
        check("routedFrame[$i].encode", got.contentEquals(want),
            "got ${got.size}B want ${want.size}B")
        val decoded = Frames.unwrapRoutedRelayFrame(want)
        check(
            "routedFrame[$i].decode",
            decoded.targetPeerId == o.optStr("target") &&
                decoded.sourcePeerId == o.optStr("source") &&
                decoded.payload.contentEquals(payload),
        )
    }

    // ---------------------------------------------------------------- pair codes
    root.optArr("pairCodes")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        if (o.has("code")) {
            val random = hexToBytes(o.optStr("randomHex")!!)
            val got = PairCode.generate(random)
            check("pairCode[$i].generate", got == o.optStr("code"),
                "got $got want ${o.optStr("code")}")
        } else {
            val raw = o.optStr("raw")!!
            check("pairCode[$i].normalize", PairCode.normalize(raw) == o.optStr("normalized"),
                "got ${PairCode.normalize(raw)} want ${o.optStr("normalized")}")
            check("pairCode[$i].format", PairCode.format(raw) == o.optStr("formatted"),
                "got ${PairCode.format(raw)} want ${o.optStr("formatted")}")
            check("pairCode[$i].valid", PairCode.isValid(raw) == o.optBool("valid"),
                "got ${PairCode.isValid(raw)} want ${o.optBool("valid")}")
        }
    }

    // ---------------------------------------------------------------- classify
    root.optArr("classify")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val text = o.optStr("text")!!
        val want = o.optStr("kind")!!
        val got = classifyTextPayload(text)
        check("classify[$i]", got == want, "got $got want $want for ${text.take(50)}")
    }

    // ---------------------------------------------------------------- manifests
    root.optArr("manifests")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val files = JsonValue.parse(o.optStr("filesJson")!!)
        val totalBytes = o.optLong("totalBytes")
        val want = o.optBool("expected")!!
        val got = isValidFileManifest(files, totalBytes)
        check("manifest[$i]", got == want, "got $got want $want")
    }

    // ---------------------------------------------------------------- hkdf
    root.optArr("hkdf")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val key = AirCrypto.hkdfSha256(
            Base64Url.decode(o.optStr("ikmB64")!!),
            Base64Url.decode(o.optStr("saltB64")!!),
            o.optStr("info")!!.toByteArray(Charsets.UTF_8),
            32,
        )
        val want = Base64Url.decode(o.optStr("keyB64")!!)
        check("hkdf[$i]", key.contentEquals(want),
            "got ${Base64Url.encode(key)} want ${o.optStr("keyB64")}")
    }

    if (failed > 0) {
        println("VECTORS: $failed FAILED, $passed passed")
        exitProcess(1)
    }
    println("VECTORS: ALL PASS ($passed checks)")
}

private fun hexToBytes(hex: String): ByteArray {
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
        out[i] = Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16).toByte()
    }
    return out
}
