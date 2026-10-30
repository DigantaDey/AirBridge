// Compile-time stubs for the one third-party dependency of the Android app
// (com.google.zxing:core). Gradle resolves the real jar; `android/scripts/verify.sh`
// compiles app sources against android.jar only, so it points kotlinc at these
// declarations instead. Nothing here is ever packaged into the APK — keep the
// signatures identical to the upstream API the app calls.
package com.google.zxing

enum class BarcodeFormat { QR_CODE, CODE_128 }

enum class DecodeHintType { POSSIBLE_FORMATS, TRY_HARDER, CHARACTER_SET }

open class LuminanceSource(val width: Int = 0, val height: Int = 0)

class PlanarYUVLuminanceSource(
    yuvData: ByteArray,
    dataWidth: Int,
    dataHeight: Int,
    left: Int,
    top: Int,
    width: Int,
    height: Int,
    reverseHorizontal: Boolean,
) : LuminanceSource(width, height)

open class Binarizer(source: LuminanceSource) : LuminanceSource()

open class ReaderException : Exception()

class NotFoundException : ReaderException()

class Result(val text: String = "", val format: BarcodeFormat = BarcodeFormat.QR_CODE)

class BinaryBitmap(val binarizer: Binarizer)

open class MultiFormatReader {
    fun decodeWithState(image: BinaryBitmap): Result = Result()
    fun decode(image: BinaryBitmap, hints: Map<DecodeHintType, Any>?): Result = Result()
    fun setHints(hints: Map<DecodeHintType, Any>?) {}
    fun reset() {}
}
