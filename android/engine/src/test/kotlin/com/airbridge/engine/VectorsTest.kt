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
        check("chunk[$i].iv-length", iv.size == 12, "iv=${Base64Url.encode(iv)}")

        val decrypted = AirCrypto.decryptBinaryChunk(session.aesKey, iv, ct)
        check("chunk[$i].ts-decrypt", decrypted.contentEquals(plain))

        val (ourIv, ourCt) = AirCrypto.encryptBinaryChunk(session.aesKey, plain, fileIndex, chunkIndex)
        check("chunk[$i].iv-entropy-local", ourIv.size == 12 &&
            !ourIv.contentEquals(AirCrypto.chunkIv(fileIndex, chunkIndex)))
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

    // ---------------------------------------------------------------- SPAKE2
    root.optArr("spake2")!!.items.forEach { v ->
        val o = v.asObj()
        val name = o.optStr("name")!!
        val w = java.math.BigInteger(o.optStr("wHex")!!, 16)
        val x = java.math.BigInteger(o.optStr("xHex")!!, 16)
        val y = java.math.BigInteger(o.optStr("yHex")!!, 16)
        val idA = Base64Url.decode(o.optStr("idAB64")!!)
        val idB = Base64Url.decode(o.optStr("idBB64")!!)
        val aad = Base64Url.decode(o.optStr("aadB64") ?: "")
        val a = Spake2(Spake2.Role.A, w, idA, idB, aad, x)
        val b = Spake2(Spake2.Role.B, w, idA, idB, aad, y)
        check("spake2[$name].pA", a.share().toHex() == o.optStr("pAHex"), a.share().toHex())
        check("spake2[$name].pB", b.share().toHex() == o.optStr("pBHex"), b.share().toHex())
        val ra = a.finish(hexToBytes(o.optStr("pBHex")!!))
        val rb = b.finish(hexToBytes(o.optStr("pAHex")!!))
        check("spake2[$name].ke", ra.ke.toHex() == o.optStr("keHex") && rb.ke.toHex() == o.optStr("keHex"), ra.ke.toHex())
        check("spake2[$name].confirmA", ra.confirm.toHex() == o.optStr("confirmAHex"), ra.confirm.toHex())
        check("spake2[$name].confirmB", rb.confirm.toHex() == o.optStr("confirmBHex"), rb.confirm.toHex())
        check("spake2[$name].cross", Spake2.constantTimeEquals(ra.expectedPeerConfirm, rb.confirm))
        o.optStr("code")?.let { code ->
            check("spake2[$name].w-from-code", PairingProof.passwordScalar(code) == w)
        }
    }
    run {
        // Wrong password: confirmations disagree; malformed shares are rejected.
        val idA = "a".toByteArray(); val idB = "b".toByteArray()
        val a = Spake2(Spake2.Role.A, PairingProof.passwordScalar("K7Q2XP"), idA, idB)
        val b = Spake2(Spake2.Role.B, PairingProof.passwordScalar("K7Q2XQ"), idA, idB)
        val ra = a.finish(b.share()); val rb = b.finish(a.share())
        check("spake2.wrong-code", !Spake2.constantTimeEquals(ra.expectedPeerConfirm, rb.confirm))
        val bad = Spake2(Spake2.Role.A, java.math.BigInteger.TEN, idA, idB)
        check("spake2.reject-zero-share", runCatching { bad.finish(ByteArray(65).also { it[0] = 4 }) }.isFailure)
        val twice = Spake2(Spake2.Role.A, java.math.BigInteger.TEN, idA, idB)
        twice.finish(Spake2(Spake2.Role.B, java.math.BigInteger.TEN, idA, idB).share())
        check("spake2.single-use", runCatching { twice.finish(a.share()) }.isFailure)
    }

    // ---------------------------------------------------------------- pairing proof
    root.optArr("pairingProof")!!.items.forEach { v ->
        val o = v.asObj()
        val code = o.optStr("code")!!
        check("nameplate[$code]", PairingProof.nameplateFor(code) == o.optStr("nameplate"), PairingProof.nameplateFor(code))
        check("w[$code]", P256.to32(PairingProof.passwordScalar(code)).toHex() == o.optStr("wHex"))
    }
    root.optArr("vouches")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val vk = PairingProof.vouchKeyFrom(hexToBytes(o.optStr("keHex")!!))
        check("vouch[$i].key", Base64Url.encode(vk) == o.optStr("vouchKeyB64"))
        val vouch = PairingProof.peerVouch(vk, o.optStr("peerId")!!, o.optStr("publicKey")!!, o.optStr("identityKey"), o.optStr("attestation")!!)
        check("vouch[$i].mac", vouch == o.optStr("vouch"), vouch)
        check("vouch[$i].verify", PairingProof.verifyPeerVouch(vk, o.optStr("peerId")!!, o.optStr("publicKey")!!, o.optStr("identityKey"), o.optStr("attestation")!!, o.optStr("vouch")))
        check("vouch[$i].attestation-bound", !PairingProof.verifyPeerVouch(vk, o.optStr("peerId")!!, o.optStr("publicKey")!!, o.optStr("identityKey"), "legacy", o.optStr("vouch")))
    }
    root.optArr("hubProofs")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val vk = PairingProof.vouchKeyFrom(hexToBytes(o.optStr("keHex")!!))
        val proof = PairingProof.hubProof(vk, o.optStr("peerId")!!, o.optStr("pairCode")!!, o.optStr("tlsPin"))
        check("hubProof[$i]", proof == o.optStr("proof"), proof)
        check("hubProof[$i].pin-bound", !PairingProof.verifyHubProof(vk, o.optStr("peerId")!!, o.optStr("pairCode")!!, "other", o.optStr("proof")))
    }
    // ---------------------------------------------------------------- hotspot handoff
    root.optArr("handoff")!!.items.forEach { v ->
        val o = v.asObj()
        val key = o.optStr("keyB64")!!
        val beacon = o.optStr("beaconB64")!!
        val p = o.optObj("proof")!!
        val vk = Base64Url.decode(p.optStr("vouchKeyB64")!!)
        val peerId = p.optStr("peerId")!!
        check("handoff.proof", PairingProof.handoffProof(vk, peerId, key, beacon) == p.optStr("value"))
        val info = Handoff.Info(key, beacon, p.optStr("value")!!)
        check("handoff.proof.verify", Handoff.verifyInfo(vk, peerId, info))
        check("handoff.proof.peer-bound", !Handoff.verifyInfo(vk, "fedcba9876543210", info))
        check("handoff.proof.key-bound", !Handoff.verifyInfo(vk, peerId, info.copy(key = AirCrypto.generateIdentityKeyPair().publicKeyB64)))
        check("handoff.info.json", Handoff.Info.parse(info.toJson()) == info)
        o.optArr("authKeys")!!.items.forEach { a ->
            val code = a.optStr("code")!!
            check("handoff.authKey[$code]", Base64Url.encode(Handoff.authKey(code)) == a.optStr("keyB64"))
        }
        o.optArr("tags")!!.items.forEachIndexed { i, t ->
            val now = t.optLong("now")!!
            val tag = Base64Url.decode(t.optStr("tagB64")!!)
            check("handoff.tag[$i]", Handoff.beaconTag(Base64Url.decode(beacon), now).contentEquals(tag))
            check("handoff.tag[$i].matches", Handoff.matchesTag(beacon, tag, now))
            check("handoff.tag[$i].skew", Handoff.matchesTag(beacon, tag, now + Handoff.BEACON_WINDOW_MS))
            check("handoff.tag[$i].stale", !Handoff.matchesTag(beacon, tag, now + 3 * Handoff.BEACON_WINDOW_MS))
            check("handoff.tag[$i].other-computer", !Handoff.matchesTag(Base64Url.encode(ByteArray(16) { 9 }), tag, now))
        }
        o.optArr("seals")!!.items.forEachIndexed { i, sv ->
            val so = sv.asObj()
            val off = so.optObj("offer")!!
            val offer = Handoff.Offer(
                ssid = off.optStr("ssid")!!,
                psk = off.optStr("psk")!!,
                security = Handoff.Security.values().first { it.wire == off.optStr("sec") },
                reversePort = off.optInt("rp")!!,
                identityKey = off.optStr("id")!!,
                deviceName = off.optStr("name")!!,
            )
            val sealed = Handoff.seal(
                key, so.optStr("code")!!, offer,
                ephemeralPrivate = java.math.BigInteger(so.optStr("ephemeralHex")!!, 16),
                iv = Base64Url.decode(so.optStr("ivB64")!!),
                nonce = Base64Url.decode(so.optStr("nonceB64")!!),
                issuedAt = so.optLong("issuedAt")!!,
            )
            check("handoff.seal[$i]", Base64Url.encode(sealed) == so.optStr("envelopeB64"), Base64Url.encode(sealed).take(40))
            val random = Handoff.seal(key, so.optStr("code")!!, offer)
            check("handoff.seal[$i].randomized", random.size == sealed.size && !random.contentEquals(sealed) && random[0] == 1.toByte())
        }
        val rejects = listOf(
            Handoff.Offer("x".repeat(33), "password1", Handoff.Security.WPA2, 47390, "", "P"),
            Handoff.Offer("ok", "short", Handoff.Security.WPA2, 47390, "", "P"),
            Handoff.Offer("bad\nname", "password1", Handoff.Security.WPA2, 47390, "", "P"),
        )
        rejects.forEachIndexed { i, r -> check("handoff.validate.reject[$i]", runCatching { Handoff.validate(r) }.isFailure) }
        check("handoff.status.parse", Handoff.parseBleStatus("{\"s\":\"joined\",\"r\":\"Joined X\"}".toByteArray()) == (Handoff.State.JOINED to "Joined X"))
        check("handoff.status.junk", Handoff.parseBleStatus("nope".toByteArray()) == null)
    }
    root.optArr("identityBindings")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val ok = PairingProof.verifyIdentityBinding(o.optStr("identityKey")!!, o.optStr("sig")!!, o.optStr("sessionKey")!!)
        check("identityBinding[$i]", ok == (o.optBool("valid") == true), "got $ok")
    }
    run {
        val dir = java.nio.file.Files.createTempDirectory("airbridge-id").toFile()
        val file = java.io.File(dir, "identity")
        val first = SoftwareDeviceIdentity(file)
        val again = SoftwareDeviceIdentity(file)
        check("identity.persistent", first.persistent && again.persistent && first.publicKeyB64 == again.publicKeyB64)
        val session = AirCrypto.generateIdentityKeyPair().publicKeyB64
        val sig = again.signBinding(session)
        check("identity.kotlin-signed-verifies", PairingProof.verifyIdentityBinding(first.publicKeyB64, sig, session))
        check("identity.der-roundtrip", EcdsaSignatures.derToRaw(EcdsaSignatures.rawToDer(Base64Url.decode(sig))).contentEquals(Base64Url.decode(sig)))
        check("identity.memory-not-persistent", !SoftwareDeviceIdentity(null).persistent)
        dir.deleteRecursively()
    }
    root.optArr("sessionsV2")!!.items.forEachIndexed { i, v ->
        val o = v.asObj()
        val priv = AirCrypto.importPrivateKey(Base64Url.decode(o.optStr("pkcs8")!!))
        val session = AirCrypto.derivePeerSession(priv, o.optStr("pubA")!!, o.optStr("pubB")!!, o.optStr("idMine")!! to o.optStr("idPeer")!!)
        check("sessionV2[$i].sas", session.sasCode == o.optStr("sas"), "got ${session.sasCode} want ${o.optStr("sas")}")
        check("sessionV2[$i].fingerprint", session.fingerprintHex == o.optStr("fingerprint"))
        val swapped = AirCrypto.derivePeerSession(priv, o.optStr("pubA")!!, o.optStr("pubB")!!, o.optStr("idPeer")!! to o.optStr("idMine")!!)
        check("sessionV2[$i].symmetric", swapped.sasCode == session.sasCode)
    }
    check("relayRoute.parse", RelayRoute.parse("relay.example.com:4740", "a".repeat(64)) == RelayRoute("relay.example.com", 4740, "a".repeat(64)) &&
        RelayRoute.parse("[2001:db8::1]:4740", "b".repeat(64))?.host == "2001:db8::1" &&
        RelayRoute.parse("relay:0", "a".repeat(64)) == null && RelayRoute.parse("relay:1", "xyz") == null)

    // ------------------------------------------------------- phone continuity
    root.optArr("continuity")?.items?.forEach { cv ->
        val c = cv.asObj()
        fun cardFrom(o: JsonValue.Obj) = ContactCard(
            name = o.optStr("name")!!,
            phones = o.optArr("phones")!!.items.map { ContactPhone(it.asObj().optStr("number")!!, it.asObj().optStr("label")) },
            emails = o.optArr("emails")!!.items.map { ContactEmail(it.asObj().optStr("address")!!, it.asObj().optStr("label")) },
            organization = o.optStr("organization"),
            note = o.optStr("note"),
            id = o.optStr("id"),
            starred = o.optBool("starred") == true,
        )
        c.optArr("vcards")!!.items.forEachIndexed { i, v ->
            val o = v.asObj()
            val cards = o.optArr("cards")!!.items.map { cardFrom(it.asObj()) }
            val built = VCard.buildAll(cards)
            check("continuity.vcard.build[$i]", built == o.optStr("vcard"), "got ${built.replace("\r\n", "|")}")
            check("continuity.vcard.roundtrip[$i]", VCard.parse(built).map { it.name } == cards.map { it.name.trim() })
        }
        c.optArr("parses")!!.items.forEachIndexed { i, v ->
            val o = v.asObj()
            val want = o.optArr("cards")!!.items.map { cardFrom(it.asObj()) }
            val got = VCard.parse(o.optStr("text")!!)
            check("continuity.vcard.parse[$i]", got == want, "got $got want $want")
        }
        c.optArr("phones")!!.items.forEachIndexed { i, v ->
            val o = v.asObj()
            val input = o.optStr("input")!!
            check("continuity.phone.sanitize[$i]", Continuity.sanitizePhoneNumber(input) == o.optStr("sanitized"), "got ${Continuity.sanitizePhoneNumber(input)}")
            check("continuity.phone.dial[$i]", Continuity.dialableNumber(input) == o.optStr("dialable"), "got ${Continuity.dialableNumber(input)}")
        }
        c.optArr("calls")!!.items.forEachIndexed { i, v ->
            val o = v.asObj()
            val got = Continuity.sanitizeCall(o.optObj("input")!!, 0)
            val want = o.optObj("sanitized")?.let { w ->
                CallInfo(
                    callId = w.optStr("callId")!!, state = w.optStr("state")!!, direction = w.optStr("direction")!!,
                    number = w.optStr("number"), name = w.optStr("name"), connectedAt = w.optLong("connectedAt"),
                    updatedAt = w.optLong("updatedAt")!!, actions = w.optArr("actions")!!.items.map { it.asString() },
                    audioRoute = w.optStr("audioRoute"),
                )
            }
            check("continuity.call[$i]", got == want, "got $got want $want")
        }
        c.optArr("quality")!!.items.forEachIndexed { i, v ->
            val o = v.asObj()
            val got = Continuity.nextQuality(o["q"]!!.asDouble(), o.optLong("rtt")!!)
            check("continuity.quality[$i]", Math.abs(got - o["next"]!!.asDouble()) < 1e-9, "got $got")
        }
        c.optArr("frames")!!.items.forEachIndexed { i, v ->
            val o = v.asObj()
            val key = javax.crypto.spec.SecretKeySpec(hexToBytes(o.optStr("keyHex")!!), "AES")
            val aad = Continuity.encodeScreenAad(o.optStr("sessionId")!!, o.optLong("seq")!!, o.optInt("codec")!!, o.optInt("width")!!, o.optInt("height")!!)
            check("continuity.frame.aad[$i]", aad.toHex() == o.optStr("aadHex"))
            val plain = hexToBytes(o.optStr("plainHex")!!)
            val (iv, ct) = AirCrypto.encryptMediaFrame(key, aad, plain, hexToBytes(o.optStr("ivHex")!!))
            val frame = Continuity.encodeScreenFrame(aad, iv, ct)
            check("continuity.frame.seal[$i]", frame.toHex() == o.optStr("frameHex"))
            val decoded = Continuity.decodeScreenFrame(hexToBytes(o.optStr("frameHex")!!))
            check("continuity.frame.decode[$i]", decoded.sessionId == o.optStr("sessionId") && decoded.seq == o.optLong("seq") &&
                decoded.width == o.optInt("width") && decoded.height == o.optInt("height") && decoded.codec == o.optInt("codec"))
            check("continuity.frame.open[$i]", AirCrypto.decryptMediaFrame(key, decoded.aad, decoded.iv, decoded.ciphertext).contentEquals(plain))
            val forged = hexToBytes(o.optStr("frameHex")!!).also { it[20] = (it[20].toInt() xor 1).toByte() }
            val f = Continuity.decodeScreenFrame(forged)
            check("continuity.frame.tamper[$i]", runCatching { AirCrypto.decryptMediaFrame(key, f.aad, f.iv, f.ciphertext) }.isFailure)
        }
        c.optArr("audio")!!.items.forEachIndexed { i, v ->
            val o = v.asObj()
            val key = javax.crypto.spec.SecretKeySpec(hexToBytes(o.optStr("keyHex")!!), "AES")
            val aad = Continuity.encodeScreenAudioAad(o.optStr("sessionId")!!, o.optLong("seq")!!, o.optInt("codec")!!, o.optInt("channels")!!, o.optInt("sampleRate")!!)
            check("continuity.audio.aad[$i]", aad.toHex() == o.optStr("aadHex"))
            val plain = hexToBytes(o.optStr("plainHex")!!)
            val (iv, ct) = AirCrypto.encryptMediaFrame(key, aad, plain, hexToBytes(o.optStr("ivHex")!!))
            check("continuity.audio.seal[$i]", Continuity.encodeScreenAudioFrame(aad, iv, ct).toHex() == o.optStr("frameHex"))
            val d = Continuity.decodeScreenAudioFrame(hexToBytes(o.optStr("frameHex")!!))
            check("continuity.audio.decode[$i]", d.sessionId == o.optStr("sessionId") && d.seq == o.optLong("seq") &&
                d.channels == o.optInt("channels") && d.sampleRate == o.optInt("sampleRate") && d.codec == o.optInt("codec"))
            check("continuity.audio.open[$i]", AirCrypto.decryptMediaFrame(key, d.aad, d.iv, d.ciphertext).contentEquals(plain))
        }
    }

    if (failed > 0) {
        println("VECTORS: $failed FAILED, $passed passed")
        exitProcess(1)
    }
    println("VECTORS: ALL PASS ($passed checks)")
}

private fun ByteArray.toHex(): String = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

private fun hexToBytes(hex: String): ByteArray {
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
        out[i] = Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16).toByte()
    }
    return out
}
