import { describe, expect, it } from 'vitest';
import {
  getActivity,
  getService,
  hasForegroundServiceType,
  hasPermission,
  readAndroidManifest,
  readRepoFile,
} from '../harness/index.js';

const APP = 'android/app/src/main/kotlin/com/airbridge/app';

/**
 * F21: phone continuity on Android (contacts, calls, screen sharing). Every
 * permission is tied to the code that needs it, and the capture pipeline
 * follows Android 14+ MediaProjection rules.
 */
describe('F21: Phone continuity (Android)', () => {
  it('declares each continuity permission only alongside its real use', async () => {
    const manifest = await readAndroidManifest();
    const continuity = await readRepoFile(`${APP}/PhoneContinuity.kt`);

    expect(hasPermission(manifest, 'READ_CONTACTS')).toBe(true);
    expect(continuity).toContain('ContactsContract.Data.CONTENT_URI');
    expect(continuity).toContain('ContactsContract.PhoneLookup.CONTENT_FILTER_URI');

    expect(hasPermission(manifest, 'READ_PHONE_STATE')).toBe(true);
    expect(continuity).toContain('PhoneStateListener.LISTEN_CALL_STATE');
    expect(hasPermission(manifest, 'ANSWER_PHONE_CALLS')).toBe(true);
    expect(continuity).toContain('acceptRingingCall()');
    expect(continuity).toContain('endCall()');
    expect(hasPermission(manifest, 'CALL_PHONE')).toBe(true);
    expect(continuity).toContain('placeCall(');

    // Show a time-to-full estimate only when the Android platform can provide one.
    expect(continuity).toContain('computeChargeTimeRemaining()');
    expect(continuity).toContain('BatteryChargeEstimate.sanitize');
    expect(continuity).not.toContain('BatteryManager.EXTRA_VOLTAGE');

    // Playback Capture is optional, per-session, and uses the platform API;
    // there is no package/DRM classification or alternate capture path.
    expect(hasPermission(manifest, 'RECORD_AUDIO')).toBe(true);
    const screen = await readRepoFile(`${APP}/ScreenShareService.kt`);
    expect(screen).toContain('AudioPlaybackCaptureConfiguration.Builder(mp)');
    expect(screen).toContain('Also share permitted app audio (videos, music, games)');
    expect(screen).toContain('isChecked = false');
    expect(screen).toContain('not microphone recording');
    expect(screen).toContain('setScreenAudioAvailable');
    expect(screen).not.toMatch(/netflix|hotstar|disney\+|drm app list/i);
    // Call history is not needed for remote controls and is intentionally absent.
    expect(hasPermission(manifest, 'READ_CALL_LOG')).toBe(false);
    expect(continuity).not.toContain('callerIdGranted');

    // Contact cards from the computer go through the system editor.
    expect(hasPermission(manifest, 'WRITE_CONTACTS')).toBe(false);
    const contacts = await readRepoFile(`${APP}/ContactActivities.kt`);
    expect(contacts).toContain('ContactsContract.Intents.Insert.ACTION');

    // Telephony is optional so tablets can still install (contacts + screen work there).
    expect(manifest.rawXml).toMatch(/android:name="android\.hardware\.telephony"\s+android:required="false"/);
  });

  it('keeps call controls responsive during contact queries and enriches caller names asynchronously', async () => {
    const engine = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Engine.kt');
    const channel = await readRepoFile('android/engine/src/main/kotlin/com/airbridge/engine/Continuity.kt');
    const calls = await readRepoFile(`${APP}/PhoneContinuity.kt`);
    expect(engine).toContain('contactQueryExecutor');
    expect(engine).toContain('override fun executeContactQuery(task: () -> Unit)');
    expect(channel).toContain('host.executeContactQuery {');
    expect(calls).toContain('identityWorker');
    expect(calls).toContain('resolveCallerName(it.callId, it.number!!)');
    const callEvents = calls.slice(calls.indexOf('private fun handle(state: Int, rawNumber: String?)'), calls.indexOf('private fun resolveCallerName('));
    expect(callEvents.indexOf('publish?.let(onChange)')).toBeGreaterThanOrEqual(0);
    expect(callEvents.indexOf('publish?.let(onChange)')).toBeLessThan(callEvents.indexOf('resolveCallerName(it.callId'));
    expect(callEvents).not.toContain('contacts.lookupName(number)');
  });

  it('starts sensitive remote capabilities disabled and revokes a live screen share when disabled', async () => {
    const prefs = await readRepoFile(`${APP}/Prefs.kt`);
    const continuity = await readRepoFile(`${APP}/PhoneContinuity.kt`);
    expect(prefs).toContain('getBoolean("contactsOnComputer", false)');
    expect(prefs).toContain('getBoolean("callsFromComputer", false)');
    expect(prefs).toContain('getBoolean("screenSharing", false)');
    expect(continuity).toContain('ch.contactsReady = prefs.contactsOnComputer');
    expect(continuity).toContain('ch.callsReady = callsOk');
    expect(continuity).toContain('ch.screenSourceAvailable = screenSharingEnabled');
    expect(continuity).toContain('ch.declineScreenShare(request.sessionId, "Screen sharing was disabled on the phone")');
    expect(continuity).toContain('ch.stopScreenShare(sessionId, "Screen sharing was disabled on the phone")');
  });

  it('runs screen capture in a private mediaProjection foreground service', async () => {
    const manifest = await readAndroidManifest();
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_MEDIA_PROJECTION')).toBe(true);
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_MICROPHONE')).toBe(true);
    const svc = getService(manifest, 'ScreenShareService');
    expect(svc?.exported).toBe(false);
    expect(hasForegroundServiceType(manifest, 'ScreenShareService', 'mediaProjection')).toBe(true);
    // The always-on connection service must not claim the capture type.
    expect(hasForegroundServiceType(manifest, 'ConnectionService', 'mediaProjection')).toBe(false);
    expect(getActivity(manifest, 'ScreenShareConsentActivity')?.exported).toBe(false);
    expect(getActivity(manifest, 'ContactImportActivity')?.exported).toBe(false);
  });

  it('follows Android 14 MediaProjection ordering and consent', async () => {
    const svc = await readRepoFile(`${APP}/ScreenShareService.kt`);
    const fgs = svc.indexOf('FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION');
    const token = svc.indexOf('mpm?.getMediaProjection(');
    const callback = svc.indexOf('registerCallback(');
    const display = svc.indexOf('createVirtualDisplay(');
    expect(fgs).toBeGreaterThan(0);
    expect(token).toBeGreaterThan(fgs); // foreground service first
    expect(callback).toBeGreaterThan(token);
    expect(display).toBeGreaterThan(callback); // callback before the virtual display
    // One virtual display per token: later size changes resize it.
    expect(svc).toContain('vd.resize(');
    // Encoded access units flow only after consent and are dropped under the
    // engine's bounded flow-control window rather than queued as JPEG images.
    expect(svc.indexOf('acceptScreenShare(')).toBeGreaterThan(token);
    expect(svc).toContain('MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)');
    expect(svc).toContain('sendScreenVideoFrame(');
    expect(svc).toContain('BUFFER_FLAG_KEY_FRAME');
    expect(svc).not.toContain('Bitmap.CompressFormat.JPEG');
    expect(svc).toContain('createScreenCaptureIntent()');
  });

  it('accepts shared vCards from contacts apps and wires the engine callbacks', async () => {
    const manifest = await readAndroidManifest();
    expect(manifest.rawXml).toMatch(/ShareContactActivity[\s\S]*?text\/x-vcard[\s\S]*?text\/vcard/);
    const host = await readRepoFile(`${APP}/NativeEngineHost.kt`);
    expect(host).toContain('phoneContinuity.attach(created.continuity)');
    expect(host).toContain('override fun onScreenShareRequest(');
    expect(host).toContain('override fun onContactsReceived(');
    expect(host).toContain('override fun onScreenShareEnded(');
    expect(host).toContain('phoneContinuity.detach()');
    const main = await readRepoFile(`${APP}/MainActivity.kt`);
    expect(main).toContain('refreshContinuity()');
  });
});
