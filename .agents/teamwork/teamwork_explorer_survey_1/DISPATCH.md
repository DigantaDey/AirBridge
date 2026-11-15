# Survey Explorer 1: Android UI & Architecture

Target: Map out the existing WebView UI, JavaScript bridge, UI components, assets, user flows (device discovery, connection status, file transfers, settings), and architectural plan to migrate to Jetpack Compose.
State folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_1/
Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
Original request: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md


## 2026-11-14T16:41:34Z
Sender: b1f332cd-d3fc-47c3-8ee9-ce273ea50971
Content:
You are a teamwork_explorer tasked with mapping the Android UI and client architecture for the AirBridge project.

## Context & Inputs
- Original Request path: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md (MANDATORY: Read this file first)
- Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
- Your State folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_1/

## Objective
Map the current Android user interface implementation and plan the migration from WebView to fully native Android Jetpack Compose UI:
1. Locate and inspect the current Android UI code (Activities, Fragments, WebView setup, JavaScript interface / bridge, Web assets in assets/ or res/).
2. Identify all UI screens, views, dialogues, and states:
   - Device discovery / paired devices / nearby devices
   - Connection status / handshake indicators
   - Active file transfers (progress bar, speed, cancel/pause, transfer history)
   - Settings (storage location, port, device name, auto-accept, etc.)
   - Clipboard status / sync controls
3. Detail how the existing WebView JS bridge communicates with native Android services/classes (what methods, events, and data structures are exchanged).
4. Propose the native Jetpack Compose architecture (screens, ViewModels/StateFlow, navigation, theme, Material3 design).
5. Document required dependencies (Compose BOM, Compose Material3, Navigation, etc.) and any existing UI/view artifacts to be deprecated or removed.

## Scope Boundaries
- Do NOT modify or write source code.
- Read-only exploration and analysis.

## Output Requirements
Write your detailed report to `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_1/handoff.md`.
Also maintain `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_1/progress.md` with timestamps.
Send a message when complete with a summary of findings and the path to handoff.md.

## Completion Criteria
A comprehensive handoff.md detailing all existing UI components, JS bridge contracts, user flows, and a complete Jetpack Compose native UI architecture specification.
