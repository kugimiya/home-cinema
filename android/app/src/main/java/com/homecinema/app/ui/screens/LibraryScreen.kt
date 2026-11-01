package com.homecinema.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.homecinema.app.data.api.EmptyBody
import com.homecinema.app.data.api.HomeCinemaApi
import com.homecinema.app.data.api.StorageSummary
import com.homecinema.app.data.api.TorrentEntry
import com.homecinema.app.data.api.TorrentFileStat
import com.homecinema.app.data.api.formatBytes
import com.homecinema.app.data.api.fileBasename
import com.homecinema.app.data.api.fileStatusLabel
import com.homecinema.app.ui.components.LoadingOverlay
import com.homecinema.app.ui.components.PrimaryButton
import com.homecinema.app.ui.components.SecondaryButton
import com.homecinema.app.ui.theme.HomeError
import com.homecinema.app.ui.theme.HomeMuted
import com.homecinema.app.ui.util.userFacingError
import android.util.Log
import com.homecinema.app.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import androidx.compose.material3.CircularProgressIndicator

@Composable
fun LibraryScreen(
    api: HomeCinemaApi,
    apiBaseUrl: String,
    onWatchTorrent: (String) -> Unit,
    onWatchFile: (hash: String, fileId: Int) -> Unit,
) {
    var torrents by remember { mutableStateOf<List<TorrentEntry>>(emptyList()) }
    var storage by remember { mutableStateOf<StorageSummary?>(null) }
    var expanded by remember { mutableStateOf(setOf<String>()) }
    var error by remember { mutableStateOf<String?>(null) }
    var busyHash by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val loadMutex = remember { Mutex() }

    suspend fun load(detail: List<String>? = null, showSpinner: Boolean = false) {
        loadMutex.withLock {
            if (showSpinner) {
                if (torrents.isEmpty()) loading = true else refreshing = true
            }
            try {
                val detailParam = detail?.joinToString(",")
                val data = api.listTorrents(detailParam)
                torrents = data.torrents
                storage = data.storage
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) {
                    Log.e("HomeCinema", "library load failed", e)
                }
                error = userFacingError(e)
            } finally {
                loading = false
                refreshing = false
            }
        }
    }

    LaunchedEffect(apiBaseUrl) {
        load(showSpinner = true)
        while (true) {
            delay(15_000)
            load(expanded.toList().ifEmpty { null })
        }
    }

    Column(Modifier.fillMaxSize()) {
        Text("Библиотека / раздача", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
        Text("Торренты остаются до ручного удаления.", color = HomeMuted, modifier = Modifier.padding(vertical = 4.dp))

        storage?.let { s ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column { Text("Свободно", color = HomeMuted); Text(formatBytes(s.diskFreeBytes)) }
                Column { Text("Раздачи", color = HomeMuted); Text(formatBytes(s.torrentsDataBytes)) }
                Column { Text("Диск", color = HomeMuted); Text(formatBytes(s.diskTotalBytes)) }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            SecondaryButton(
                text = "Обновить",
                enabled = !refreshing && busyHash == null,
                onClick = { scope.launch { load(expanded.toList().ifEmpty { null }, showSpinner = true) } },
            )
            if (refreshing || busyHash != null) {
                CircularProgressIndicator(strokeWidth = 3.dp, modifier = Modifier.padding(4.dp))
            }
        }
        error?.let { Text(it, color = HomeError, modifier = Modifier.padding(top = 8.dp)) }

        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(top = 8.dp),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(torrents, key = { it.hash }) { t ->
                    TorrentCard(
                    entry = t,
                    expanded = expanded.contains(t.hash),
                    busy = busyHash == t.hash,
                    onToggle = {
                        scope.launch {
                            val open = !expanded.contains(t.hash)
                            expanded = if (open) expanded + t.hash else expanded - t.hash
                            if (open) load(listOf(t.hash))
                        }
                    },
                    onWatch = { onWatchTorrent(t.hash) },
                    onWatchFile = { f -> onWatchFile(t.hash, f.id) },
                    onWarm = {
                        if (t.probeWarmEnabled != true) return@TorrentCard
                        scope.launch {
                            busyHash = t.hash
                            try {
                                api.startWarmProbe(t.hash, EmptyBody())
                                load(listOf(t.hash))
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = userFacingError(e)
                            } finally {
                                busyHash = null
                            }
                        }
                    },
                    onPause = {
                        scope.launch {
                            busyHash = t.hash
                            try {
                                api.pauseDownload(t.hash, EmptyBody())
                                load()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = userFacingError(e)
                            } finally {
                                busyHash = null
                            }
                        }
                    },
                    onDelete = {
                        scope.launch {
                            busyHash = t.hash
                            try {
                                api.deleteTorrent(t.hash, deleteFiles = true)
                                expanded = expanded - t.hash
                                load()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = userFacingError(e)
                            } finally {
                                busyHash = null
                            }
                        }
                    },
                )
                }
            }
            LoadingOverlay(
                visible = loading,
                message = "Загрузка библиотеки…",
            )
            if (!loading && torrents.isEmpty()) {
                androidx.compose.material3.Text(
                    "Пока нет сохранённых торрентов.",
                    color = HomeMuted,
                    modifier = Modifier
                        .align(androidx.compose.ui.Alignment.TopCenter)
                        .padding(top = 12.dp),
                )
            }
        }
    }
}

@Composable
private fun TorrentCard(
    entry: TorrentEntry,
    expanded: Boolean,
    busy: Boolean,
    onToggle: () -> Unit,
    onWatch: () -> Unit,
    onWatchFile: (TorrentFileStat) -> Unit,
    onWarm: () -> Unit,
    onPause: () -> Unit,
    onDelete: () -> Unit,
) {
    Box(Modifier.fillMaxWidth()) {
    Column(Modifier.fillMaxWidth().padding(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton(
                text = if (entry.fileStats.isNullOrEmpty()) "·" else if (expanded) "▼" else "▶",
                enabled = !entry.fileStats.isNullOrEmpty(),
                onClick = onToggle,
            )
            Column(Modifier.weight(1f)) {
                Text(entry.title)
                entry.statString?.let { Text(it, color = HomeMuted) }
                entry.warmSummary?.let { Text(it, color = HomeMuted) }
            }
        }
        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PrimaryButton(text = "Смотреть", enabled = !busy, onClick = onWatch)
            SecondaryButton(text = "ffprobe", enabled = !busy && entry.probeWarmEnabled == true, onClick = onWarm)
            SecondaryButton(text = "Стоп", enabled = !busy, onClick = onPause)
            SecondaryButton(text = "Удалить", enabled = !busy, onClick = onDelete)
        }
        if (expanded) {
            entry.fileStats.orEmpty().forEach { f ->
                Row(
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(fileBasename(f.path))
                        Text(fileStatusLabel(f), color = HomeMuted)
                    }
                    if (f.kind == "video") {
                        SecondaryButton(text = "Файл", onClick = { onWatchFile(f) })
                    }
                }
            }
        }
    }
        LoadingOverlay(
            visible = busy,
            message = "Выполняется…",
            modifier = Modifier.matchParentSize(),
        )
    }
}
