package com.airbridge.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.airbridge.engine.AirBridgeEngine
import com.airbridge.engine.EngineListener
import com.airbridge.engine.Peer
import com.airbridge.engine.TransferView
import com.airbridge.engine.formatBytes

/**
 * Framework-Views UI (no AndroidX): connect via mDNS or URL, pick a peer,
 * send files/clipboard, accept incoming offers. The engine itself lives in
 * [EngineService]; this activity only attaches/detaches listeners.
 */
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var serverInput: EditText
    private lateinit var pairInput: EditText
    private lateinit var peerList: ListView
    private lateinit var transferList: ListView
    private lateinit var discovery: ServerDiscovery

    private val peerNames = mutableListOf<String>()
    private val peerIds = mutableListOf<String>()
    private val transferLines = mutableListOf<String>()
    private lateinit var peerAdapter: ArrayAdapter<String>
    private lateinit var transferAdapter: ArrayAdapter<String>
    private var selectedPeerId: String? = null
    private var engine: AirBridgeEngine? = null
    private var pendingOffer: TransferView? = null

    private val uiListener = object : EngineListener {
        override fun onConnectionState(state: com.airbridge.engine.ConnectionState) {
            runOnUiThread { status.text = "Status: $state" }
        }
        override fun onWelcome(info: com.airbridge.engine.WelcomeInfo) {
            runOnUiThread {
                status.text = "Connected as ${info.peerId} · pair ${info.pairCode}"
                if (pairInput.text.isEmpty()) pairInput.setText(info.pairCode)
            }
        }
        override fun onPeersChanged(peers: List<Peer>) {
            runOnUiThread {
                peerNames.clear()
                peerIds.clear()
                for (p in peers) {
                    peerIds.add(p.peerId)
                    peerNames.add("${p.device.name} · ${p.device.platform} · ${p.peerId}")
                }
                if (selectedPeerId !in peerIds) selectedPeerId = peerIds.firstOrNull()
                peerAdapter.notifyDataSetChanged()
            }
        }
        override fun onPairCodeChanged(pairCode: String) {
            runOnUiThread { pairInput.setText(pairCode) }
        }
        override fun onIncomingOffer(transfer: TransferView) {
            runOnUiThread { showOfferDialog(transfer) }
        }
        override fun onTransferChanged(transfer: TransferView) {
            runOnUiThread {
                transferLines.clear()
                for (t in serviceEngine()?.transfersSnapshot() ?: listOf(transfer)) {
                    transferLines.add(
                        "${if (t.direction.name == "OUTGOING") "↑" else "↓"} " +
                            "${t.peerName}: ${t.status} " +
                            "${t.transferredBytes}/${t.totalBytes} " +
                            "(${t.files.firstOrNull()?.name ?: ""})",
                    )
                }
                transferAdapter.notifyDataSetChanged()
            }
        }
        override fun onClipboard(item: com.airbridge.engine.ClipboardItem) {
            runOnUiThread {
                if (item.contentType == "text" && item.text.isNotEmpty()) {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("AirBridge", item.text))
                    Toast.makeText(this@MainActivity, "Clipboard received from ${item.peerName}", Toast.LENGTH_SHORT).show()
                }
            }
        }
        override fun onError(code: String, message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, "$code: $message", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        requestRuntimePermissions()
        buildUi()
        startEngineServiceIfConfigured()
        discovery = ServerDiscovery(
            this,
            onFound = { url, name ->
                runOnUiThread {
                    serverInput.setText(url)
                    Toast.makeText(this, "Found AirBridge at $name", Toast.LENGTH_SHORT).show()
                }
            },
            onLost = { },
        )
        discovery.start()
    }

    override fun onStart() {
        super.onStart()
        serviceEngine()?.let { e ->
            engine = e
            e.addListener(uiListener)
            refreshFromEngine()
        }
    }

    override fun onStop() {
        engine?.removeListener(uiListener)
        engine = null
        super.onStop()
    }

    override fun onDestroy() {
        discovery.stop()
        super.onDestroy()
    }

    private fun serviceEngine(): AirBridgeEngine? = EngineService.current()?.engineOrNull()

    private fun startEngineServiceIfConfigured() {
        val url = prefs.serverUrl
        if (url.isBlank()) return
        val i = Intent(this, EngineService::class.java)
            .setAction(EngineService.ACTION_CONNECT)
            .putExtra(EngineService.EXTRA_URL, url)
        startService(i)
        serverInput.setText(url)
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }

        status = TextView(this).apply { text = "Status: idle" }
        root.addView(status)

        // Server row
        val serverRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        serverInput = EditText(this).apply {
            hint = "ws://host:3411/ws"
            setText(prefs.serverUrl)
            setSingleLine(true)
        }
        val connectBtn = Button(this).apply {
            text = "Connect"
            setOnClickListener { connect(serverInput.text.toString().trim()) }
        }
        serverRow.addView(serverInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        serverRow.addView(connectBtn)
        root.addView(serverRow)

        // Pair-code row
        val pairRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        pairInput = EditText(this).apply {
            hint = "Pair code"
            setSingleLine(true)
        }
        val joinBtn = Button(this).apply {
            text = "Join"
            setOnClickListener {
                val ok = serviceEngine()?.joinPairCode(pairInput.text.toString()) ?: false
                Toast.makeText(this@MainActivity, if (ok) "Pair code joined" else "Invalid pair code", Toast.LENGTH_SHORT).show()
            }
        }
        pairRow.addView(pairInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        pairRow.addView(joinBtn)
        root.addView(pairRow)

        // Peers
        root.addView(sectionLabel("Devices"))
        peerAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, peerNames)
        peerList = ListView(this).apply {
            adapter = peerAdapter
            choiceMode = ListView.CHOICE_MODE_SINGLE
            onItemClickListener = android.widget.AdapterView.OnItemClickListener { _, _, pos, _ ->
                selectedPeerId = peerIds.getOrNull(pos)
                Toast.makeText(this@MainActivity, "Selected ${peerNames[pos]}", Toast.LENGTH_SHORT).show()
            }
        }
        root.addView(peerList, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(140)))

        // Action buttons
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        actions.addView(Button(this).apply {
            text = "Send files"
            setOnClickListener { pickFiles() }
        })
        actions.addView(Button(this).apply {
            text = "Send clipboard"
            setOnClickListener { sendClipboard() }
        })
        actions.addView(Button(this).apply {
            text = "Hide"
            setOnClickListener { toggleVisibility() }
        })
        root.addView(actions)

        // Transfers
        root.addView(sectionLabel("Transfers"))
        transferAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, transferLines)
        transferList = ListView(this).apply { adapter = transferAdapter }
        root.addView(transferList, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun sectionLabel(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 16f
            setPadding(0, dp(8), 0, dp(4))
        }

    private fun connect(url: String) {
        if (url.isBlank() || !(url.startsWith("ws://") || url.startsWith("wss://"))) {
            Toast.makeText(this, "Enter ws:// or wss:// URL", Toast.LENGTH_SHORT).show()
            return
        }
        prefs.serverUrl = url
        val i = Intent(this, EngineService::class.java)
            .setAction(EngineService.ACTION_CONNECT)
            .putExtra(EngineService.EXTRA_URL, url)
        startService(i)
        // Service creates the engine asynchronously-ish; retry attach shortly.
        status.text = "Status: connecting to $url"
        peerList.postDelayed({ onStart() }, 300)
    }

    private fun pickFiles() {
        val peer = selectedPeerId ?: run {
            Toast.makeText(this, "Select a device first", Toast.LENGTH_SHORT).show()
            return
        }
        val target = peer
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        startActivityForResult(Intent.createChooser(intent, "Send files"), REQ_PICK)
        pickedPeer = target
    }

    private var pickedPeer: String? = null

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PICK || resultCode != RESULT_OK || data == null) return
        val peer = pickedPeer ?: return
        val e = serviceEngine() ?: run {
            Toast.makeText(this, "Not connected", Toast.LENGTH_SHORT).show()
            return
        }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
        } ?: data.data?.let { uris.add(it) }
        val sources = uris.mapNotNull { ContentUriFileSource.resolve(this, it) }
        if (sources.isEmpty()) {
            Toast.makeText(this, "No readable files", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val id = e.sendFiles(peer, sources)
            Toast.makeText(this, "Sending ${sources.size} file(s)", Toast.LENGTH_SHORT).show()
            android.util.Log.i("AirBridge", "transfer $id started")
        } catch (ex: Exception) {
            Toast.makeText(this, "Send failed: ${ex.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun sendClipboard() {
        val peer = selectedPeerId ?: run {
            Toast.makeText(this, "Select a device first", Toast.LENGTH_SHORT).show()
            return
        }
        val e = serviceEngine() ?: run {
            Toast.makeText(this, "Not connected", Toast.LENGTH_SHORT).show()
            return
        }
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        if (text.isNullOrEmpty()) {
            Toast.makeText(this, "Clipboard is empty", Toast.LENGTH_SHORT).show()
            return
        }
        e.sendClipboardText(peer, text.take(256_000))
        Toast.makeText(this, "Clipboard sent", Toast.LENGTH_SHORT).show()
    }

    private fun toggleVisibility() {
        val next = when (prefs.visibility) {
            "nearby" -> "paired-only"
            "paired-only" -> "hidden"
            else -> "nearby"
        }
        prefs.visibility = next
        serviceEngine()?.setVisibility(next)
        Toast.makeText(this, "Visibility: $next", Toast.LENGTH_SHORT).show()
    }

    private fun showOfferDialog(transfer: TransferView) {
        pendingOffer = transfer
        AlertDialog.Builder(this)
            .setTitle("Incoming transfer")
            .setMessage(
                "From ${transfer.peerName}\n" +
                    "${transfer.files.size} file(s) · ${formatBytes(transfer.totalBytes)}",
            )
            .setPositiveButton("Accept") { _, _ ->
                serviceEngine()?.acceptIncomingTransfer(transfer.transferId)
                pendingOffer = null
            }
            .setNegativeButton("Decline") { _, _ ->
                serviceEngine()?.declineIncomingTransfer(transfer.transferId)
                pendingOffer = null
            }
            .setOnCancelListener { pendingOffer = null }
            .show()
    }

    private fun refreshFromEngine() {
        val e = engine ?: return
        onPeersRefresh(e)
        transferLines.clear()
        for (t in e.transfersSnapshot()) {
            transferLines.add("${t.status} ${t.peerName} ${t.transferredBytes}/${t.totalBytes}")
        }
        transferAdapter.notifyDataSetChanged()
        status.text = "Status: ${e.currentState}"
    }

    private fun onPeersRefresh(e: AirBridgeEngine) {
        val peers = e.peersSnapshot()
        peerNames.clear()
        peerIds.clear()
        for (p in peers) {
            peerIds.add(p.peerId)
            peerNames.add("${p.device.name} · ${p.device.platform} · ${p.peerId}")
        }
        peerAdapter.notifyDataSetChanged()
    }

    private fun requestRuntimePermissions() {
        val wanted = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33) wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        if (Build.VERSION.SDK_INT < 29) wanted.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        val missing = wanted.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), REQ_PERMS)
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val REQ_PICK = 11
        private const val REQ_PERMS = 12
    }
}
