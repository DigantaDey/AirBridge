# Survey Explorer 2: Protocol & Transfer Pipeline (Speed/Throughput & Memory)

Target: Map out the communication protocol between desktop (src/server/*, src/client/*) and Android app, packet framing, serialization, socket streaming, chunking, buffer sizes, flow control, and identify all bottlenecks causing low transfer speeds (KB/s vs multi-MB/s) as well as memory leaks / OOM / heap thrashing.
State folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_2/
Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
Original request: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md


## 2026-11-14T16:42:06Z
You are a teamwork_explorer tasked with mapping the AirBridge communication protocol, transfer engine, and performance bottlenecks.

## Context & Inputs
- Original Request path: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/ORIGINAL_REQUEST.md (MANDATORY: Read this file first)
- Working directory: /Users/digantadey/AndroidStudioProjects/AirBridge
- Your State folder: /Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_2/

## Objective
Map and analyze the networking protocols, file transfer pipeline, and performance bottlenecks between Desktop (`src/server/*`, `src/client/*`) and Android (`android/`):
1. Locate and inspect the socket communication code, protocols, packet/frame framing, serialization/deserialization (e.g. JSON, binary, byte buffers), handshake, encryption/auth if any.
2. Trace the exact file transfer data path on both sending and receiving sides (desktop and Android):
   - How chunks/frames are read from disk, packaged, sent across sockets.
   - Buffer sizes, socket write/read patterns, flush calls, acknowledge mechanisms, flow control.
   - Why transfer speeds are currently bottlenecked in KB/s instead of multi-MB/s (identify bottlenecks: e.g. base64 encoding over webview/websockets, small chunk sizes, synchronous ack per frame, unbuffered streams, heap allocations per chunk).
3. Analyze memory usage, garbage collection pressure, heap thrashing, buffer starvation, and OutOfMemory risk during large file transfers (e.g. multiple GB files).
4. Propose concrete optimizations for sustained multi-MB/s throughput (e.g. raw TCP socket / NIO / Okio / channels, optimized chunk size like 64KB-1MB, zero-copy or direct buffer streaming, pipelined / windowed flow control without lockstep roundtrips).

## Scope Boundaries
- Do NOT modify or write source code.
- Read-only exploration and analysis.

## Output Requirements
Write your detailed report to `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_2/handoff.md`.
Also maintain `/Users/digantadey/AndroidStudioProjects/AirBridge/.agents/teamwork/teamwork_explorer_survey_2/progress.md` with timestamps.
Send a message when complete with a summary of findings and the path to handoff.md.

## Completion Criteria
A comprehensive handoff.md detailing the protocol structure, root causes of the throughput bottleneck, memory/OOM risks, and an actionable high-speed transfer pipeline design for multi-MB/s throughput.
