package com.homecinema.app.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import com.homecinema.app.ui.components.LoadingOverlay
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.homecinema.app.data.api.HomeCinemaApi
import com.homecinema.app.data.api.PreparePlayBody
import com.homecinema.app.data.api.PrepareResponse
import com.homecinema.app.data.api.TorrentMediaFile
import com.homecinema.app.data.api.formatBytes
import com.homecinema.app.ui.components.PrimaryButton
import com.homecinema.app.ui.components.SecondaryButton
import com.homecinema.app.ui.theme.HomeError
import com.homecinema.app.ui.theme.HomeMuted
import com.homecinema.app.ui.util.userFacingError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

@Composable
fun WatchPrepareScreen(
    api: HomeCinemaApi,
    provider: String,
    externalId: String,
    onReady: (hash: String) -> Unit,
    onBack: () -> Unit,
) {
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(provider, externalId) {
        try {
            val res = api.preparePlay(PreparePlayBody(provider, externalId))
            onReady(res.hash.lowercase())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = userFacingError(e)
        }
    }
    Box(Modifier.fillMaxSize().padding(24.dp)) {
        if (error == null) {
            LoadingOverlay(
                visible = true,
                message = "Добавляем торрент и получаем метаданные…",
            )
        } else {
            Column {
            Text(error!!, color = HomeError)
            SecondaryButton(text = "К поиску", onClick = onBack, modifier = Modifier.padding(top = 12.dp))
            }
        }
    }
}

@Composable
fun WatchSelectScreen(
    api: HomeCinemaApi,
    hash: String,
    onPlayFile: (fileIndex: Int) -> Unit,
    onBack: () -> Unit,
) {
    var session by remember { mutableStateOf<PrepareResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(hash) {
        val deadline = System.currentTimeMillis() + 600_000
        while (System.currentTimeMillis() < deadline) {
            try {
                val st = api.fetchPrepare(hash)
                session = st
                if (st.ready) return@LaunchedEffect
                if (st.phase == "missing") {
                    error = st.message
                    return@LaunchedEffect
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = userFacingError(e)
                return@LaunchedEffect
            }
            delay(2500)
        }
        error = "Таймаут ожидания метаданных (10 мин)."
    }

    Box(Modifier.fillMaxSize().padding(16.dp)) {
        Column(Modifier.fillMaxSize()) {
            SecondaryButton(text = "Назад", onClick = onBack)
            when {
                error != null -> Text(error!!, color = HomeError, modifier = Modifier.padding(top = 12.dp))
                session != null && session!!.ready -> {
                    val s = session!!
                    Text(s.title, style = androidx.compose.material3.MaterialTheme.typography.titleLarge)
                    Text(s.message, color = HomeMuted)
                    val playable = s.files.filter { it.kind == "video" || it.kind == "audio" }
                    if (playable.isEmpty()) {
                        Text(
                            "В торренте нет видео- или аудиофайлов.",
                            color = HomeError,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    } else {
                        Text(
                            "Качается только выбранный файл. Для видео субтитры — в плеере.",
                            color = HomeMuted,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                        LazyColumn(Modifier.padding(top = 12.dp)) {
                            items(playable, key = { it.id }) { f ->
                                MediaFileRow(file = f, onPlay = { onPlayFile(f.id) })
                            }
                        }
                    }
                }
            }
        }
        LoadingOverlay(
            visible = error == null && (session == null || session?.ready != true),
            message = session?.message ?: "Подготовка торрента…",
        )
    }
}

@Composable
private fun MediaFileRow(file: TorrentMediaFile, onPlay: () -> Unit) {
    Column(Modifier.padding(vertical = 8.dp)) {
        Text(file.name)
        Text(
            "${if (file.kind == "audio") "Аудио" else "Видео"} · ${formatBytes(file.length)}",
            color = HomeMuted,
        )
        PrimaryButton(
            text = if (file.kind == "audio") "Слушать" else "Смотреть",
            onClick = onPlay,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}
