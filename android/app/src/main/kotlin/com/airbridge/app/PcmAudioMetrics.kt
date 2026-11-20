package com.airbridge.app

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Lightweight signal diagnostics for signed 16-bit little-endian PCM buffers.
 * Pure JVM implementation so Android unit tests can verify silence/RMS thresholds
 * directly without Android instrumentation.
 */
object PcmAudioMetrics {

    /**
     * Computes normalized root-mean-square amplitude in `[0.0, 1.0]` for signed
     * 16-bit little-endian PCM data across `[0, effectiveBytes)`.
     */
    fun computePcm16Rms(pcmS16le: ByteArray, length: Int = pcmS16le.size): Double {
        val sampleCount = length.coerceAtMost(pcmS16le.size) / 2
        if (sampleCount <= 0) return 0.0
        var sumSquares = 0.0
        for (i in 0 until sampleCount) {
            val offset = i * 2
            val low = pcmS16le[offset].toInt() and 0xff
            val high = pcmS16le[offset + 1].toInt()
            val sample = ((high shl 8) or low).toShort().toDouble() / 32768.0
            sumSquares += sample * sample
        }
        return sqrt(sumSquares / sampleCount).coerceIn(0.0, 1.0)
    }

    /**
     * Returns true when any signed 16-bit little-endian sample meets or exceeds
     * [threshold] (default `2` avoids treating quantization dither/zero-fill as speech).
     */
    fun hasNonZeroPcm16(pcmS16le: ByteArray, length: Int = pcmS16le.size, threshold: Int = 2): Boolean {
        val sampleCount = length.coerceAtMost(pcmS16le.size) / 2
        if (sampleCount <= 0) return false
        val cutoff = threshold.coerceAtLeast(1)
        for (i in 0 until sampleCount) {
            val offset = i * 2
            val low = pcmS16le[offset].toInt() and 0xff
            val high = pcmS16le[offset + 1].toInt()
            val sample = ((high shl 8) or low).toShort().toInt()
            if (abs(sample) >= cutoff) return true
        }
        return false
    }
}
