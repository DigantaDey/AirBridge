package com.airbridge.app

import android.content.ClipboardManager
import android.content.Context
import com.airbridge.engine.Limits

/** Plain, non-sensitive text only. Never dereference a clipboard URI/provider. */
object ClipboardText {
    fun read(context: Context): String? = try {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = manager.primaryClip
        if (clip == null || clip.itemCount == 0 || !clip.description.hasMimeType("text/*") ||
            clip.description.extras?.getBoolean("android.content.extra.IS_SENSITIVE", false) == true) null
        else clip.getItemAt(0)?.text?.takeIf { it.isNotBlank() && it.length <= Limits.MAX_CLIPBOARD_TEXT }?.toString()
    } catch (_: Exception) {
        // A foreground service/Accessibility is NOT a background-read permission.
        null
    }
}
