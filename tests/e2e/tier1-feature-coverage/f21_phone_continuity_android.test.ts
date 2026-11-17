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
    // Caller number via the user-granted Caller ID role, never the Play-restricted
    // call-log permission (optional: calls still work without it).
    expect(hasPermission(manifest, 'READ_CALL_LOG')).toBe(false);
    expect(hasPermission(manifest, 'PROCESS_OUTGOING_CALLS')).toBe(false);
    expect(continuity).toContain('callerIdGranted');
    const screening = getService(manifest, 'CallerIdService');
    expect(screening?.permission).toBe('android.permission.BIND_SCREENING_SERVICE');
    const callerId = await readRepoFile(`${APP}/CallerIdService.kt`);
    expect(callerId).toContain('RoleManager.ROLE_CALL_SCREENING');
    // Always allows the call: no block / reject / silence.
    expect(callerId).toContain('respondToCall(details, CallResponse.Builder().build())');
    expect(callerId).not.toMatch(/setDisallowCall\(true\)|setRejectCall\(true\)|setSilenceCall\(true\)/);

    // Contact cards from the computer go through the system editor.
    expect(hasPermission(manifest, 'WRITE_CONTACTS')).toBe(false);
    const contacts = await readRepoFile(`${APP}/ContactActivities.kt`);
    expect(contacts).toContain('ContactsContract.Intents.Insert.ACTION');

    // Telephony is optional so tablets can still install (contacts + screen work there).
    expect(manifest.rawXml).toMatch(/android:name="android\.hardware\.telephony"\s+android:required="false"/);
  });

  it('runs screen capture in a private mediaProjection foreground service', async () => {
    const manifest = await readAndroidManifest();
    expect(hasPermission(manifest, 'FOREGROUND_SERVICE_MEDIA_PROJECTION')).toBe(true);
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
    // Frames flow only after the user accepted, through the engine's flow control.
    expect(svc.indexOf('acceptScreenShare(')).toBeGreaterThan(token);
    expect(svc).toContain('canSendScreenFrame(');
    expect(svc).toContain('sendScreenFrame(');
    expect(svc).toContain('createScreenCaptureIntent()');
  });

  it('casts with sound from the phone without bypassing consent or copy protection', async () => {
    const manifest = await readAndroidManifest();
    const svc = await readRepoFile(`${APP}/ScreenShareService.kt`);
    // Playback capture only (media/game), tied to the projection; never the mic.
    expect(svc).toContain('AudioPlaybackCaptureConfiguration.Builder(mp)');
    expect(svc).not.toContain('MediaRecorder.AudioSource.MIC');
    expect(svc).not.toMatch(/setAudioSource\(/);
    expect(hasPermission(manifest, 'RECORD_AUDIO')).toBe(true);
    expect(hasForegroundServiceType(manifest, 'ScreenShareService', 'microphone')).toBe(false);
    // Sound is decided before accepting, so the computer learns audio=false when silent.
    expect(svc.indexOf('createAudioRecord(mp)')).toBeLessThan(svc.indexOf('acceptScreenShare(id, withAudio'));
    // Protected content is explained, not worked around.
    expect(svc).toContain('screenNotice(');
    expect(svc).not.toMatch(/FLAG_SECURE\s*=|clearFlags\(.*FLAG_SECURE/);
    // An invite skips only AirBridge's own dialog: Android's capture prompt always runs.
    const consent = svc.slice(svc.indexOf('class ScreenShareConsentActivity'));
    expect(consent).toContain('if (request.invited)');
    expect(consent).toContain('createScreenCaptureIntent()');
    const card = await readRepoFile(`${APP}/ui/components/CastScreenCard.kt`);
    expect(card).toContain('castScreen(');
    const host = await readRepoFile(`${APP}/NativeEngineHost.kt`);
    expect(host).toContain('inviteScreenShare(peerId, audio)');
  });

  it('keeps identity keys out of backups and device transfers', async () => {
    const manifest = await readAndroidManifest();
    expect(manifest.rawXml).toContain('android:allowBackup="false"');
    expect(manifest.rawXml).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    const rules = await readRepoFile('android/app/src/main/res/xml/data_extraction_rules.xml');
    expect(rules).toMatch(/<cloud-backup>[\s\S]*domain="sharedpref"[\s\S]*<device-transfer>[\s\S]*domain="sharedpref"/);
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
