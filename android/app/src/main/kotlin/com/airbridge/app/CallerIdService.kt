package com.airbridge.app

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log
import com.airbridge.engine.Continuity

/**
 * Caller ID for the computer without the restricted call-log permission.
 *
 * Android only reveals an incoming caller's number to the default dialer, to
 * apps holding READ_CALL_LOG (restricted on Google Play), or to the app the
 * user picks as "Caller ID & spam app" (ROLE_CALL_SCREENING, Android 10+).
 * AirBridge uses the role: it reads the number of an incoming call so the
 * computer can show who is calling, and ALWAYS lets the call through — it never
 * blocks, silences, rejects or logs calls. Contacts' calls are only passed to
 * the service when Contacts access is allowed, which the Contacts feature asks
 * for anyway.
 */
class CallerIdService : CallScreeningService() {
    override fun onScreenCall(details: Call.Details) {
        try {
            val incoming = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
                details.callDirection == Call.Details.DIRECTION_INCOMING
            if (incoming) {
                val number = Continuity.sanitizePhoneNumber(details.handle?.schemeSpecificPart)
                if (number != null) CallMonitor.offerCallerId(number)
            }
        } catch (e: Exception) {
            Log.w(TAG, "caller id unavailable: ${e.message}")
        } finally {
            // Allow, unmodified: no block, no silence, no call-log or notification changes.
            runCatching { respondToCall(details, CallResponse.Builder().build()) }
        }
    }

    companion object {
        private const val TAG = "AirBridgeCallerId"

        /** Android 10+ offers the Caller ID role. */
        fun supported(context: Context): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                context.getSystemService(RoleManager::class.java)?.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) == true

        fun held(context: Context): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true

        /** The system "Set AirBridge as your Caller ID app?" prompt; null when unavailable. */
        fun requestIntent(context: Context): Intent? {
            if (!supported(context) || held(context)) return null
            return context.getSystemService(RoleManager::class.java)?.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
        }
    }
}
