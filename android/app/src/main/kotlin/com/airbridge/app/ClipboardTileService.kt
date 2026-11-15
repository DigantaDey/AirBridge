package com.airbridge.app

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick Settings tile giving the user a 1-tap clipboard beam from any app on
 * Android 10–15 without depending solely on Accessibility focus overlays.
 */
class ClipboardTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val paired = Prefs(this).pairingLink() != null
        tile.label = "Beam clipboard"
        tile.icon = Icon.createWithResource(this, android.R.drawable.stat_sys_upload_done)
        tile.state = if (paired) Tile.STATE_INACTIVE else Tile.STATE_UNAVAILABLE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = if (paired) "AirBridge" else "Unpaired"
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        val launch = Runnable {
            val intent = Intent(this, ClipboardBeamActivity::class.java)
                .setPackage(packageName)
                .setAction(ConnectionService.ACTION_BEAM_CLIPBOARD)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    val pi = PendingIntent.getActivity(
                        this,
                        TILE_REQUEST_CODE,
                        intent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                    startActivityAndCollapse(pi)
                } else {
                    startLegacyActivityAndCollapse(intent)
                }
            }
        }
        if (isLocked) {
            unlockAndRun(launch)
        } else {
            launch.run()
        }
    }

    @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
    @Suppress("DEPRECATION")
    private fun startLegacyActivityAndCollapse(intent: Intent) {
        startActivityAndCollapse(intent)
    }

    companion object {
        private const val TILE_REQUEST_CODE = 3421
    }
}
