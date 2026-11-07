package com.airbridge.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.View.MeasureSpec
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlin.math.abs
import kotlin.math.min
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Full-screen camera QR scanner covering the WebView.
 *
 * Deliberately framework-only (Camera2 + ZXing core): the compositor draws the
 * dimmed frame, so the scanner looks like the rest of the UI instead of an OEM
 * dialog. Closing it hands control back to the caller — the unpaired connect
 * screen stays usable without a camera.
 */
class QrScannerView(context: Context) : FrameLayout(context) {

    /** Called on the main thread with the decoded payload. */
    var onCode: ((String) -> Unit)? = null

    /** Called on the main thread when the user taps close. */
    var onClose: (() -> Unit)? = null

    /** Called on the main thread when no usable camera could be opened. */
    var onCameraUnavailable: (() -> Unit)? = null

    private val preview = AspectPreview(context)
    private val previewHost = FrameLayout(context).apply {
        setBackgroundColor(Color.BLACK)
        addView(preview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER))
    }
    private val overlay = ScannerOverlay(context)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var headerChrome: LinearLayout? = null
    private var footerChrome: LinearLayout? = null
    private val decoding = AtomicBoolean(false)

    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private val zxing = MultiFormatReader()
    private val hints: Map<DecodeHintType, Any> = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
    )
    private var wanted = false
    @Volatile private var delivered = false

    init {
        setBackgroundColor(Color.BLACK)
        addView(previewHost, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(overlay, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(buildChrome(), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        installChromeInsets()

        preview.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                if (wanted) startCamera()
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                stopCamera()
            }
        })
    }

    /** Starts the camera (the CAMERA permission must already be granted). */
    fun start() {
        wanted = true
        if (preview.holder.surface?.isValid == true) startCamera()
    }

    /** Stops the camera and releases its thread. */
    fun release() {
        wanted = false
        stopCamera()
    }

    // ------------------------------------------------------------------- chrome

    private fun buildChrome(): View {
        val header = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            setPadding(dp(20), dp(28), dp(12), 0)
        }
        val titles = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
        }
        titles.addView(TextView(context).apply {
            text = "Scan to pair"
            setTextColor(CHROME_TEXT)
            textSize = 22f
            letterSpacing = -0.01f
            setPadding(0, dp(6), 0, dp(4))
        })
        titles.addView(TextView(context).apply {
            text = "Point the camera at the QR code AirBridge shows on your computer."
            setTextColor(CHROME_MUTED)
            textSize = 13f
        })
        header.addView(titles, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val close = TextView(context).apply {
            text = "×"
            setTextColor(CHROME_TEXT)
            textSize = 26f
            gravity = Gravity.CENTER
            contentDescription = "Close the scanner"
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(0x33FFFFFF)
            }
            isClickable = true
            setOnClickListener { onClose?.invoke() }
        }
        header.addView(close, LinearLayout.LayoutParams(dp(40), dp(40)))

        val footer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), 0, dp(24), dp(36))
        }
        headerChrome = header
        footerChrome = footer
        footer.addView(TextView(context).apply {
            text = "No camera or a broken code? Close this and enter the address shown by AirBridge."
            setTextColor(CHROME_MUTED)
            textSize = 12f
            gravity = Gravity.CENTER
        })
        footer.addView(TextView(context).apply {
            text = "Enter address instead"
            setTextColor(CHROME_TEXT)
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, dp(18), 0, dp(10))
            isClickable = true
            setOnClickListener { onClose?.invoke() }
        })

        val container = FrameLayout(context)
        container.addView(header, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        container.addView(footer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        return container
    }

    /** Dimmed backdrop with a clear square and corner brackets. */
    private inner class ScannerOverlay(context: Context) : View(context) {
        private val scrim = Paint().apply { color = 0xB0000000.toInt() }
        private val bracket = Paint().apply {
            color = Color.WHITE
            style = Paint.Style.STROKE
            strokeWidth = dpf(2.5f)
            strokeCap = Paint.Cap.ROUND
            isAntiAlias = true
        }
        private val hole = RectF()

        override fun onDraw(canvas: Canvas) {
            val side = min(min(width, height) * 0.66f, dpf(320f))
            val left = (width - side) / 2f
            val top = (height - side) / 2f
            hole.set(left, top, left + side, top + side)

            val mask = Path().apply {
                fillType = Path.FillType.EVEN_ODD
                addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW)
                addRoundRect(hole, dpf(20f), dpf(20f), Path.Direction.CW)
            }
            canvas.save()
            canvas.clipPath(mask)
            canvas.drawPaint(scrim)
            canvas.restore()

            val arm = side * 0.16f
            val radius = dpf(20f)
            // Four L-shaped corners; each arm is drawn from the corner inwards.
            canvas.drawLine(hole.left + radius, hole.top, hole.left + arm, hole.top, bracket)
            canvas.drawLine(hole.left, hole.top + radius, hole.left, hole.top + arm, bracket)
            canvas.drawLine(hole.right - radius, hole.top, hole.right - arm, hole.top, bracket)
            canvas.drawLine(hole.right, hole.top + radius, hole.right, hole.top + arm, bracket)
            canvas.drawLine(hole.left + radius, hole.bottom, hole.left + arm, hole.bottom, bracket)
            canvas.drawLine(hole.left, hole.bottom - radius, hole.left, hole.bottom - arm, bracket)
            canvas.drawLine(hole.right - radius, hole.bottom, hole.right - arm, hole.bottom, bracket)
            canvas.drawLine(hole.right, hole.bottom - radius, hole.right, hole.bottom - arm, bracket)
        }
    }

    /** Keep scanner chrome clear of the status and navigation bars. */
    private fun installChromeInsets() {
        setOnApplyWindowInsetsListener { _, insets ->
            val (top, bottom) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                bars.top to bars.bottom
            } else {
                legacySystemBarInsets(insets)
            }
            headerChrome?.let {
                it.setPadding(it.paddingLeft, dp(28) + top, it.paddingRight, it.paddingBottom)
            }
            footerChrome?.let {
                it.setPadding(it.paddingLeft, it.paddingTop, it.paddingRight, dp(36) + bottom)
            }
            insets
        }
    }

    @Suppress("DEPRECATION")
    private fun legacySystemBarInsets(insets: WindowInsets): Pair<Int, Int> =
        insets.systemWindowInsetTop to insets.systemWindowInsetBottom

    /** A SurfaceView that centre-crops the camera stream instead of stretching it. */
    private inner class AspectPreview(context: Context) : SurfaceView(context) {
        var aspectRatio = 0f

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val width = MeasureSpec.getSize(widthMeasureSpec)
            val height = MeasureSpec.getSize(heightMeasureSpec)
            if (aspectRatio <= 0f || width == 0 || height == 0) {
                super.onMeasure(widthMeasureSpec, heightMeasureSpec)
                return
            }
            val viewAspect = width.toFloat() / height.toFloat()
            if (viewAspect > aspectRatio) {
                setMeasuredDimension(width, (width / aspectRatio).toInt())
            } else {
                setMeasuredDimension((height * aspectRatio).toInt(), height)
            }
        }
    }

    // ------------------------------------------------------------------- camera

    private fun startCamera() {
        if (camera != null) return
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val info = try {
            pickCamera(manager)
        } catch (e: CameraAccessException) {
            Log.w(TAG, "camera unavailable: ${e.message}")
            null
        }
        if (info == null) {
            mainHandler.post { onCameraUnavailable?.invoke() }
            return
        }
        preview.aspectRatio = previewAspect(info)
        preview.requestLayout()
        val thread = HandlerThread("airbridge-qr").also { it.start() }
        cameraThread = thread
        val handler = Handler(thread.looper)
        cameraHandler = handler

        val imageReader = ImageReader.newInstance(
            info.size.width,
            info.size.height,
            ImageFormat.YUV_420_888,
            2,
        )
        reader = imageReader
        imageReader.setOnImageAvailableListener({ available -> onFrame(available) }, handler)

        try {
            manager.openCamera(info.cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    camera = device
                    configure(device, imageReader)
                }

                override fun onDisconnected(device: CameraDevice) {
                    device.close()
                    camera = null
                }

                override fun onError(device: CameraDevice, error: Int) {
                    Log.w(TAG, "camera error $error")
                    device.close()
                    camera = null
                }
            }, handler)
        } catch (e: Exception) {
            Log.w(TAG, "openCamera failed: ${e.message}")
            stopCamera()
            mainHandler.post { onCameraUnavailable?.invoke() }
        }
    }

    private class CameraSpec(
        val cameraId: String,
        val size: android.util.Size,
        val sensorOrientation: Int,
        val displayDegrees: Int,
    )

    private fun pickCamera(manager: CameraManager): CameraSpec? {
        val ids = manager.cameraIdList
        if (ids.isEmpty()) return null
        val back = ids.firstOrNull {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) ==
                CameraCharacteristics.LENS_FACING_BACK
        }
        val cameraId = back ?: ids.first()
        val characteristics = manager.getCameraCharacteristics(cameraId)
        val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
        val previewSizes = map.getOutputSizes(SurfaceHolder::class.java)?.toList().orEmpty()
        val analysisSizes = map.getOutputSizes(ImageFormat.YUV_420_888)?.toList().orEmpty()
        if (analysisSizes.isEmpty()) return null
        val analysisKeys = analysisSizes.map { it.width to it.height }.toSet()
        val shared = previewSizes.filter {
            (it.width to it.height) in analysisKeys && it.width <= 1920 && it.height <= 1920
        }
        val sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
        val displayDegrees = displayRotationDegrees()
        val targetAspect = resources.displayMetrics.widthPixels.toFloat() /
            resources.displayMetrics.heightPixels.toFloat()
        // Prefer a stream whose displayed aspect matches this screen; otherwise
        // the centre-crop would discard a large part of the QR frame.
        val aspectMatched = shared.filter {
            abs(previewAspect(it, sensorOrientation, displayDegrees) - targetAspect) <= 0.08f
        }
        val size = (aspectMatched.ifEmpty { shared })
            .maxByOrNull { it.width.toLong() * it.height }
            ?: analysisSizes.filter { it.width <= 1920 }
                .maxByOrNull { it.width.toLong() * it.height }
            ?: analysisSizes.first()
        return CameraSpec(cameraId, size, sensorOrientation, displayDegrees)
    }

    private fun displayRotationDegrees(): Int {
        @Suppress("DEPRECATION")
        val rotation = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
            .defaultDisplay.rotation
        return when (rotation) {
            Surface.ROTATION_0 -> 0
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
    }

    private fun previewAspect(
        size: android.util.Size,
        sensorOrientation: Int,
        displayDegrees: Int,
    ): Float {
        val rotation = (sensorOrientation - displayDegrees + 360) % 360
        val width = if (rotation == 90 || rotation == 270) size.height else size.width
        val height = if (rotation == 90 || rotation == 270) size.width else size.height
        return width.toFloat() / height.toFloat()
    }

    private fun previewAspect(spec: CameraSpec): Float =
        previewAspect(spec.size, spec.sensorOrientation, spec.displayDegrees)

    private fun configure(device: CameraDevice, imageReader: ImageReader) {
        val handler = cameraHandler ?: return
        val surface = preview.holder.surface
        val targets = mutableListOf<Surface>()
        if (surface != null && surface.isValid) targets.add(surface)
        targets.add(imageReader.surface)
        try {
            val builder = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
            for (target in targets) builder.addTarget(target)
            // Fixed-focus cameras reject continuous AF; the preview still works.
            try {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
            } catch (_: Exception) {
            }
            val request = builder
            @Suppress("DEPRECATION")
            device.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(configured: CameraCaptureSession) {
                    session = configured
                    try {
                        configured.setRepeatingRequest(request.build(), null, handler)
                    } catch (e: Exception) {
                        Log.w(TAG, "setRepeatingRequest failed: ${e.message}")
                    }
                }

                override fun onConfigureFailed(failed: CameraCaptureSession) {
                    Log.w(TAG, "capture session configuration failed")
                }
            }, handler)
        } catch (e: Exception) {
            Log.w(TAG, "createCaptureSession failed: ${e.message}")
        }
    }

    private fun stopCamera() {
        try {
            session?.close()
        } catch (_: Exception) {
        }
        session = null
        try {
            camera?.close()
        } catch (_: Exception) {
        }
        camera = null
        try {
            reader?.close()
        } catch (_: Exception) {
        }
        reader = null
        cameraHandler = null
        cameraThread?.quitSafely()
        cameraThread = null
    }

    // ----------------------------------------------------------------- decoding

    private fun onFrame(source: ImageReader) {
        if (delivered) return
        val image = try {
            source.acquireNextImage()
        } catch (_: Exception) {
            null
        } ?: return
        try {
            if (!decoding.compareAndSet(false, true)) return
            try {
                val text = decode(image)
                if (text != null) {
                    delivered = true
                    mainHandler.post {
                        stopCamera()
                        onCode?.invoke(text)
                    }
                }
            } finally {
                decoding.set(false)
            }
        } finally {
            try {
                image.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun decode(image: Image): String? {
        val plane = image.planes.firstOrNull() ?: return null
        if (plane.pixelStride != 1) return null
        val rowStride = plane.rowStride
        val height = image.height
        val width = image.width
        if (rowStride < width) return null
        val data = ByteArray(rowStride * height)
        val buffer = plane.buffer
        val read = min(buffer.remaining(), data.size)
        buffer.get(data, 0, read)
        val luminance = PlanarYUVLuminanceSource(data, rowStride, height, 0, 0, width, height, false)
        return try {
            zxing.decodeWithState(BinaryBitmap(HybridBinarizer(luminance))).text
        } catch (_: NotFoundException) {
            null
        } catch (_: Exception) {
            null
        } finally {
            zxing.reset()
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun dpf(value: Float): Float = value * resources.displayMetrics.density

    private companion object {
        const val TAG = "AirBridgeQr"
        val CHROME_TEXT = 0xFFF5F5F5.toInt()
        val CHROME_MUTED = 0xFFAAAAAA.toInt()
    }
}
