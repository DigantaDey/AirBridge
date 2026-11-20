import { describe, expect, it } from 'vitest';
import { readRepoFile, repoFileExists } from '../harness/index.js';

describe('F01: Jetpack Compose Native UI Contract', () => {
  it('completely removes the legacy WebView shell, ShellBridge, and LoopbackRelay', async () => {
    expect(await repoFileExists('android/app/src/main/assets/shell')).toBe(false);
    expect(await repoFileExists('android/app/src/main/kotlin/com/airbridge/app/ShellBridge.kt')).toBe(false);
    expect(await repoFileExists('android/app/src/main/kotlin/com/airbridge/app/LoopbackRelay.kt')).toBe(false);

    const activity = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt');
    expect(activity).toContain('class MainActivity : ComponentActivity()');
    expect(activity).toContain('setContent {');
    expect(activity).not.toContain('WebView');
  });

  it('enables Compose Material 3 and lifecycle dependencies in app/build.gradle.kts', async () => {
    const gradle = await readRepoFile('android/app/build.gradle.kts');
    expect(gradle).toContain('org.jetbrains.kotlin.plugin.compose');
    expect(gradle).toContain('compose = true');
    expect(gradle).toContain('material3');
    expect(gradle).toContain('activity-compose');
    expect(gradle).toContain('lifecycle-viewmodel-compose');
  });

  it('exposes immutable StateFlow streams from NativeEngineHost, ConnectionService, and AirBridgeViewModel', async () => {
    const host = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/NativeEngineHost.kt');
    expect(host).toContain('data class NativeEngineUiState(');
    expect(host).toContain('val uiState: StateFlow<NativeEngineUiState>');

    const service = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ConnectionService.kt');
    expect(service).toContain('val uiState: StateFlow<NativeEngineUiState> = sharedUiState.asStateFlow()');

    const vm = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt');
    expect(vm).toContain('val uiState: StateFlow<AirBridgeAppUiState> = combine(');
  });

  it('implements adaptive Material 3 navigation (NavigationBar < 600dp, NavigationRail >= 600dp)', async () => {
    const app = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/AirBridgeApp.kt');
    expect(app).toContain('enum class AirBridgeDestination');
    expect(app).toContain('val useRail = uiState.isPaired && (maxWidth >= 600.dp || maxHeight < 480.dp)');
    expect(app).toContain('NavigationBar {');
    expect(app).toContain('NavigationRail(');
    expect(app).toContain('contentWindowInsets = WindowInsets.safeDrawing');
  });

  it('routes edge-to-edge theming dynamically across dark, light, and system modes', async () => {
    const theme = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/ui/theme/Theme.kt');
    expect(theme).toContain('fun isResolvedDarkTheme(themeMode: String): Boolean');
    expect(theme).toContain('fun AirBridgeTheme(');

    const activity = await readRepoFile('android/app/src/main/kotlin/com/airbridge/app/MainActivity.kt');
    expect(activity).toContain('isResolvedDarkTheme(state.themeMode)');
    expect(activity).toContain('enableEdgeToEdge(');
  });
});
