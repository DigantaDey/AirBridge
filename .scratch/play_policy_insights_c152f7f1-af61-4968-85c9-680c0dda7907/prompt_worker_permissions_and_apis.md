





## Permissions and APIs Audit

### Hint: Deducing Core Functionality

Since you must determine if certain permissions are justified by the app's "core
purpose", use these fast heuristics:
1. **The "Broken" Test**: Is the feature essential to the app's primary purpose?
   If the app would still be functional and useful without the feature, it is
   NOT core functionality.
2. **Manifest Intent**: Review `AndroidManifest.xml`. The name of the `LAUNCHER`
   Activity and specialized `<intent-filter>` declarations (like default SMS
   handlers) strongly indicate the app's main purpose.
3. **Naming**: The package name (`com.airbridge.app`) and app label
   (`AirBridge`) often describe the app's purpose explicitly.
4. **Execution Context**: Usage in classes like `BackupManager` suggest core
   functionality, whereas usage in `AdHelper`, `CrashReporter`, or
   `AnalyticsManager` indicates secondary features.
5. **Mandatory Rule**: Secondary features like **advertising, analytics, or
   social sharing never justify** restricted permissions like Background
   Location, All Files Access, or Broad Media Access.

---

### Policies to Verify

#### Photo and Video Access Policy (Policy ID: photo_video_access_policy)

- **Goal**: Evaluate if the app's core functionality justifies broad access to
  photos or if it should migrate to the Android Photo Picker.
- **The Policy Spirit**: User privacy is paramount. Apps should only request
  broad media storage permissions if they are dedicated media managers (like
  Gallery or Backup apps). For standard tasks like profile picture uploads,
  custom sharing, or attaching media, developers must use scoped APIs to prevent
  security risks.
- **Evidence**:
  - `src/main/kotlin/com/airbridge/app/NativeFiles.kt (Pattern: MediaStore)`
  **Relevant Permissions Requested**:
  - `android.permission.WRITE_EXTERNAL_STORAGE`
  
  **Target SDK**: `35`
  
- **Common Evaluation Matrix**:
  | Target SDK | Broad Media Permission Requested? | Condition / Context Checked | Severity | Direct Actionable Recommendation |
  | :--- | :--- | :--- | :--- | :--- |
  | **33 or higher** | Yes | App requests broad media access (e.g. `READ_MEDIA_IMAGES`), but features only require user-selected media. | `IMPORTANT` | Migrate to the **Android Photo Picker** (`MediaStore.ACTION_PICK_IMAGES`) which does not require any permission prompt. |
  | **Any** | Yes | App requests broad storage/media permissions but is not a dedicated media manager (e.g., a social or utility app). | `IMPORTANT` | Migrate to the **Android Photo Picker** for single-item or multi-item media selection. |

- **Domain-Specific Heuristics (Strictly Bounded)**:
  Look beyond standard native file pickers. Extrapolate using this heuristic:
  1. **User-Selected Media Heuristic**: Analyze where the code handles selected
     files. If images or videos are loaded strictly via a user-facing button
     click (e.g., "Upload Avatar", "Share Photo", "Attach File") and processed
     one-at-a-time, broad filesystem media permissions are structurally
     unnecessary. Flag an `IMPORTANT` violation and recommend Photo Picker
     migration.

#### Foreground Services (Policy ID: foreground_services_policy)

- **Goal**: Verify the declaration and justification of foreground services.
- **The Policy Spirit**: Foreground services keep processes alive in the
  background and must be highly visible to users. Every declared service must
  have an appropriate `foregroundServiceType` defined in the Manifest, and
  special types like `specialUse` require specific tag property justifications.
- **Evidence**:
  - `src/main/kotlin/com/airbridge/app/ClipboardAccessibilityService.kt (Pattern: startForeground)`
- `src/main/kotlin/com/airbridge/app/ClipboardBeamActivity.kt (Pattern: startForeground)`
- `src/main/kotlin/com/airbridge/app/ConnectionService.kt (Pattern: FOREGROUND_SERVICE)`
- `src/main/kotlin/com/airbridge/app/ShareTextActivity.kt (Pattern: startForeground)`
- `src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt (Pattern: startForeground)`
  **Relevant Permissions Requested**:
  - `android.permission.FOREGROUND_SERVICE`
  
  **Target SDK**: `35`
  
- **Common Evaluation Matrix**:
  | Service Configuration | Justification Check | Severity | Direct Actionable Recommendation |
  | :--- | :--- | :--- | :--- |
  | **Missing type tag** | Foreground service is declared but lacks a `foregroundServiceType` attribute. | `CRITICAL` | Add the appropriate `android:foregroundServiceType` attribute to the service declaration in the Manifest. |
  | **Lacks specialUse property** | Service type is `specialUse`, but Manifest lacks the required `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" ...>` tag. | `CRITICAL` | Add the `<property>` tag inside the service block with a valid subtype string. |
  | **Type Misalignment** | Declared FGS type does not logically align with the app's core purpose. | `IMPORTANT` | Re-align FGS type to match app features, or migrate background operations to **WorkManager** if user-visible foreground presence is not justified. |
  | **Declaration Reminder** | Foreground service is declared (even if type is correct). | `SUGGESTION` | **Play Console Declaration Required**: For apps targeting Android 14+, you must complete a Foreground Service declaration in the Play Console (App content section) for each type used, providing a functional description, user impact video, and a specific use case selection. |

- **Domain-Specific Heuristics (Strictly Bounded)**:
  Critique specialUse justifications and service behavior:
  1. **Justification String Audit**: Read the text of the `<property>` tag for
     `specialUse`. If the text contains weak, boilerplate, or placeholder
     justifications (e.g., "requires background process for app to run"), flag
     an `IMPORTANT` violation warning the developer that Google Play reviewers
     will reject this service.
  2. **Notification Integrity**: Verify if the FGS implementation creates a
     valid user-facing notification. If no `startForeground()` or notification
     builder logic is associated with the service initiation, flag an
     `IMPORTANT` violation.
  3. **Play Console Declaration Confirmation**: If any foreground service is
     used, flag a `SUGGESTION` to remind the developer that a specialized
     declaration form in the Play Console is mandatory, requiring a video
     demonstration of the feature.

#### Accessibility API Policy (Policy ID: accessibility_api_policy)

- **Goal**: Verify the configuration and justification of Accessibility
  Services.
- **The Policy Spirit**: Accessibility APIs provide deep system access to assist
  users with disabilities. Using these APIs for non-accessibility tasks (like UI
  automation, screen scraping, background monitoring, or ad blocking) is
  strictly prohibited by Google Play and causes immediate app rejection.
- **Evidence**:
  - `src/main/kotlin/com/airbridge/app/ClipboardAccessibilityService.kt (Pattern: AccessibilityService)`
- `src/main/kotlin/com/airbridge/app/ConnectionService.kt (Pattern: AccessibilityService)`
- `src/main/kotlin/com/airbridge/app/ui/viewmodels/AirBridgeViewModel.kt (Pattern: AccessibilityService)`
  **Relevant Permissions Requested**:
  - `android.permission.BIND_ACCESSIBILITY_SERVICE`
- **Common Evaluation Matrix**:
  | Service Configuration | Real Code Usage | Justified? | Severity | Direct Actionable Recommendation |
  | :--- | :--- | :--- | :--- | :--- |
  | **`isAccessibilityTool="true"`** | Code performs screen scraping, ad blocking, or automated click routines for standard users. | No (Violation) | `CRITICAL` | **High Risk of Play Store Rejection**: Remove accessibility helper configs. Migrate UI automation to standard Android testing libraries. |
  | **`isAccessibilityTool` false/missing** | Code implements an accessibility listener but is not a dedicated helper app. | No prominent disclosure | `CRITICAL` | **High Risk of Play Store Rejection**: Because you request accessibility permission for a standard utility, you MUST implement an in-app **Prominent Disclosure and Affirmative Consent screen** before asking the user to enable the service, otherwise your app will be rejected. |

- **Domain-Specific Heuristics (Strictly Bounded)**:
  Trace the ingestion of accessibility events:
  1. **Telemetry Siphoning**: Scan the Accessibility Service methods
     (`onAccessibilityEvent`). If the service captures on-screen text,
     notifications, or keystrokes and routes them to local caches, shared
     preferences, or off-device network logging endpoints, flag a `CRITICAL`
     violation under the Accessibility API policy.

#### Files and Docs Access Policy (Policy ID: files_and_docs_policy)

- **Goal**: Evaluate if broad file access (non-media) is justified or if the
  Storage Access Framework should be used.
- **The Policy Spirit**: Storage isolation (Scoped Storage) is mandatory on
  modern Android versions. Broad access to shared files is heavily restricted.
  Standard files, documents, and download folders should be navigated using
  scoped contracts to prevent global filesystem snooping.
- **Evidence**:
  - `src/main/kotlin/com/airbridge/app/MainActivity.kt (Pattern: */*)`
  **Relevant Permissions Requested**:
  - `android.permission.WRITE_EXTERNAL_STORAGE`
  
  **Target SDK**: `35`
  
- **Common Evaluation Matrix**:
  | Target SDK | Storage Configuration | Justified? | Severity | Direct Actionable Recommendation |
  | :--- | :--- | :--- | :--- | :--- |
  | **30 or higher** | App requests broad `READ_EXTERNAL_STORAGE` or `WRITE_EXTERNAL_STORAGE` for simple document selection. | No (Violation) | `IMPORTANT` | **Scoped Storage Mandate**: Migrate your document/file selections to the **Storage Access Framework (SAF)** (`Intent.ACTION_OPEN_DOCUMENT`). |

- **Domain-Specific Heuristics (Strictly Bounded)**:
  Critique external directory creation:
  1. **Manual File Sync Heuristic**: Check if the code creates custom root-level
     folders on external storage (e.g.
     `Environment.getExternalStorageDirectory() + "/my_folder"`). If directories
     are created for standard document outputs or logging, flag an `IMPORTANT`
     violation. Direct the developer to utilize scoped storage paths.

## Output schema

Save final JSON output to `/Users/digantadey/AndroidStudioProjects/AirBridge/.scratch/play_policy_insights_c152f7f1-af61-4968-85c9-680c0dda7907/worker_{{GOAL_NAME}}.json`.

```json
{
  "domain": "Permissions and APIs",
  "findings": [
    {
      "policy_id": "STRING_VALUE (The exact Policy ID, e.g., photo_video_access_policy)",
      "issue_summary": "STRING_VALUE",
      "severity": "CRITICAL | IMPORTANT | SUGGESTION",
      "files_involved": ["STRING_VALUE"],
      "evidence": "STRING_VALUE",
      "recommendation": "STRING_VALUE"
    }
  ]
}
```

# Execution Mandates

### Technical Rules

1.  **Absolute Paths Only**: Always resolve and use absolute paths.
2.  **Containment**: Write all artifacts strictly within `/Users/digantadey/AndroidStudioProjects/AirBridge/.scratch/play_policy_insights_c152f7f1-af61-4968-85c9-680c0dda7907`.
3.  **Fail-fast**: If any required input file is missing, stop immediately and
    report the failure.

### Surgical Input Protocol & Efficient Search (MANDATORY)

-   **Direct Evidence First**: Prioritize files listed in the **Context &
    Evidence** sections. Use the provided file/line evidence (e.g., from Data
    Sources or Sinks) to jump directly to the relevant code. Do not perform
    broad workspace searches if these surgical starting points are available.
-   **Path Filtering Over File Crawling**: Locate target files by name, path, or
    extension *first* using directory/file listing tools before performing any
    text/content-based searches. Restrict searches and file reads strictly to
    the target `/Users/digantadey/AndroidStudioProjects/AirBridge/android/app`.
-   **Strict Exclusions (The Noise Wall)**: Configure search, glob, and find
    tools to ignore build, cache, dependencies, and testing folders. You MUST
    exclude matches from: `**/build/**`, `**/.gradle/**`, `**/.scratch/**`,
    `**/androidTest/**`, `**/test/**`, `**/node_modules/**`.
-   **Targeted Extensions**: Restrict content searches and file reads strictly
    to source and configuration files: `.java`, `.kt`, `.xml`, `.gradle`, `.kts`
    (and `.js`, `.ts`, `.jsx`, `.tsx`, `.dart` if a hybrid/cross-platform
    environment is analyzed). Never search or read inside compiled `.class`
    files, binary resources, or output assets.
-   **Surgical Queries & Limiters**: Use highly specific search patterns (e.g.,
    search for `getLastKnownLocation` or `deleteAccount` instead of general
    words like `location` or `delete`). If search tools support limits or
    pagination, cap results at a maximum of 50 matches. Do not load unlimited
    search results into your context window.
-   **Parallel Reading Required (Turn Efficiency)**: You are operating under a
    strict maximum turn limit. To prevent timeouts, you MUST request to read
    multiple target files concurrently in a single response. Do not read the
    evidence files sequentially one-by-one. Issue all of your file-reading tool
    calls simultaneously whenever possible.

### Evidentiary Standard & Guardrails (CRITICAL)

To prevent over-auditing, false positives, and speculative "prosecution" of
compliant code during extrapolation:

1.  **Presumption of Compliance**: Treat code as compliant unless there is
    *definitive, visible evidence* in the provided files of a policy violation.
    If code is ambiguous, or if network/database logic is hidden behind
    abstractions (e.g., calling an interface or repository method like
    `clearSession()`), you must assume standard compliant behavior. Do NOT guess
    or speculate about what happens behind interfaces.
2.  **Benefit of the Doubt**: When compliance cannot be strictly verified due to
    code abstractions or missing source file contexts, you must downgrade your
    finding:
    -   Never flag a `🔴 Critical` or `🟡 Important` finding based on suspicion or
        lack of context.
    -   Instead, output a `🔵 Suggestion` (informational) to advise the developer
        on what to double-check in their backend or configuration.
3.  **Exclusion of Local State**: Local-only processing (e.g., caching theme
    settings, user-selected visual configurations, or on-device-only database
    operations) is explicitly exempt from Data Safety collection or Account
    Deletion mandates.
4.  **Concrete Attributions**: Every `🔴 Critical` or `🟡 Important` finding must
    cite the exact file, line number, or configuration block containing the
    direct violation. If you cannot cite the exact line of code containing the
    violation, you cannot flag it as a violation.
5.  **Empty-List Discipline**: If no policy violations, discrepancies, or review
    items are identified during your audit, you MUST represent this as an empty
    array `[]` for that field (e.g., `"findings": []`, `"verified_findings":
    []`, or `"manual_verification_required": []`). **DO NOT** populate arrays
    with "dummy" objects, placeholder strings, or `"N/A"` / `"None"` values.
6.  **Heuristics & Extrapolation Boundaries**: Whenever applying specific
    heuristics defined in your goal (e.g., searching for implicit logger leaks
    or
    SDK siphoning), you must strictly bound them to the provided evidence and
    their immediate callers. You are strictly forbidden from initiating broad,
    unbounded searches for custom paths or variables across the wider codebase.
    Base your extrapolation only within the specific files already provided to
    you in the prompt.

### Finalization & Output Mandates (CRITICAL)

-   **Iterative Saving**: If your investigation requires multiple steps, save
    partial or intermediate JSON states to disk as you progress. Do not hold all
    data in memory until the very end to prevent data loss upon interruption.
-   **Strict File Output (NO TRIPLE BACKTICKS)**: You MUST save your final JSON
    output to disk at the exact path specified in the goal schema using your
    file-writing capabilities.
    -   **CRITICAL: The content written to the file MUST be pure, raw JSON. DO
        NOT wrap the contents inside the JSON file with Markdown code blocks
        (such as triple backticks `json ...`). Writing markdown blocks into the
        file makes the JSON unparseable by the compiler.**
-   **NO Chat Summaries**: **MANDATORY: DO NOT summarize your findings, explain
    your reasoning, or output JSON in your final chat response.** Your chat
    output wastes context and is ignored by the orchestrator.
-   **Verification Before Termination**: You MUST only terminate and return the
    "SUCCESS" string *after* you have explicitly verified that your JSON file
    successfully wrote to disk and contains valid JSON (e.g., by reading the
    file back or checking the directory contents).
-   **Final response**: Your final response MUST be exactly the word: "SUCCESS"
    and nothing else.
