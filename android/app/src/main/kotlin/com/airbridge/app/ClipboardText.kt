package com.airbridge.app

import android.content.ClipboardManager
import android.content.Context
import com.airbridge.engine.Limits

/** Plain, non-sensitive text only. Never dereference a clipboard URI/provider. */
object ClipboardText {
    fun read(context: Context): String? {
        return try {
            val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: return null
            val clip = manager.primaryClip ?: return null
            if (clip.itemCount == 0) return null
            val desc = clip.description ?: return null
            if (!desc.hasMimeType("text/*")) return null
            if (desc.extras?.getBoolean("android.content.extra.IS_SENSITIVE", false) == true) return null
            val text = clip.getItemAt(0)?.text ?: return null
            text.takeIf { it.isNotBlank() && it.length <= Limits.MAX_CLIPBOARD_TEXT }?.toString()
        } catch (_: Throwable) {
            // A foreground service is NOT a background-read permission.
            null
        }
    }
}
