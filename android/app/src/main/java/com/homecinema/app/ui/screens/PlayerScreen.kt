@file:OptIn(ExperimentalMaterial3Api::class)

package com.homecinema.app.ui.screens

import android.app.Activity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.homecinema.app.R
import com.homecinema.app.data.ServerEndpoints
import com.homecinema.app.data.api.AudioTrackInfo
import com.homecinema.app.data.api.HomeCinemaApi
import com.homecinema.app.data.api.PlaybackEndedBody
import com.homecinema.app.data.api.PlaySelectBody
import com.homecinema.app.data.api.PlaySelectStatus
import com.homecinema.app.data.api.PlayerState
import com.homecinema.app.data.api.TranscodeSessionBody
import com.homecinema.app.data.api.formatPlaybackTime
import com.homecinema.app.data.api.playbackUri
import com.homecinema.app.data.api.toPlayerState
import com.homecinema.app.ui.components.PrimaryButton
import com.homecinema.app.ui.components.SecondaryButton
import com.homecinema.app.ui.player.PlayerKeyDispatcher
import com.homecinema.app.ui.theme.HomeError
import com.homecinema.app.ui.theme.HomeMuted
import com.homecinema.app.ui.theme.HomeTextPrimary
import com.homecinema.app.ui.theme.homeTextFieldColors
import com.homecinema.app.BuildConfig
import com.homecinema.app.HomeCinemaApp
import android.util.Log
import com.homecinema.app.ui.components.LoadingOverlay
import com.homecinema.app.ui.util.isTelevision
import com.homecinema.app.ui.util.resolveFileDurationSec
import com.homecinema.app.ui.util.userFacingError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
fun PlayerScreen(
    api: HomeCinemaApi,
    endpoints: ServerEndpoints,
    hash: String,
    fileIndex: Int,
    initialState: PlayerState?,
    onBack: () -> Unit,
) {
    var preparing by remember { mutableStateOf(initialState == null) }
    var error by remember { mutableStateOf<String?>(null) }
    var playerState by remember { mutableStateOf(initialState) }
    var fileDurationSec by remember {
        mutableDoubleStateOf(
            initialState?.let {
                resolveFileDurationSec(it.durationSec, it.fileLengthBytes)
            } ?: 0.0,
        )
    }
    var bootstrapStatus by remember {
        mutableStateOf(
            PlaySelectStatus(
                active = true,
                step = 1,
                stepTotal = 9,
                message = "Этап 1: подготовка воспроизведения…",
            ),
        )
    }
    var selectedAudio by remember { mutableIntStateOf(initialState?.selectedAudioIndex ?: 0) }
    var playbackStartSec by remember { mutableDoubleStateOf(0.0) }
    var timelineSec by remember { mutableDoubleStateOf(0.0) }
    var scrubbing by remember { mutableStateOf(false) }
    var transcodeBusy by remember { mutableStateOf(false) }
    var transcodeError by remember { mutableStateOf<String?>(null) }
    var videoHeight by remember { mutableStateOf<Int?>(null) }
    val qualityOptions = listOf(null to "Авто", 240 to "240p", 320 to "320p", 480 to "480p", 720 to "720p", 1080 to "1080p", 1440 to "1440p")
    val context = LocalContext.current
    val view = LocalView.current
    val isTv = remember(context) { context.isTelevision() }
    var isFullscreen by remember(isTv) { mutableStateOf(isTv) }
    var fullscreenControlsVisible by remember { mutableStateOf(false) }
    var tvOverlayVisible by remember { mutableStateOf(isTv) }
    var isPlaying by remember { mutableStateOf(true) }
    val playerViewRef = remember { mutableStateOf<PlayerView?>(null) }
    val tvControlsFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(hash, preparing) {
        if (!preparing) return@LaunchedEffect
        while (isActive && preparing) {
            try {
                val st = api.playSelectStatus(hash)
                bootstrapStatus = st
            } catch (_: Exception) {
                /* keep last */
            }
            delay(450)
        }
    }

    LaunchedEffect(hash, fileIndex, initialState) {
        if (initialState != null) return@LaunchedEffect
        preparing = true
        error = null
        try {
            val res = api.selectPlayFile(PlaySelectBody(hash, fileIndex, videoHeight = videoHeight))
            val state = res.toPlayerState(endpoints)
            playerState = state
            selectedAudio = state.selectedAudioIndex
            fileDurationSec = resolveFileDurationSec(
                state.durationSec,
                state.fileLengthBytes,
            )
            timelineSec = 0.0
            playbackStartSec = 0.0
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = userFacingError(e)
        } finally {
            preparing = false
        }
    }

    val state = playerState
    val hlsMode = state != null && state.playbackMode != "direct"
    LaunchedEffect(state?.durationSec, state?.fileLengthBytes) {
        val s = state ?: return@LaunchedEffect
        val resolved = resolveFileDurationSec(s.durationSec, s.fileLengthBytes)
        if (resolved > fileDurationSec) fileDurationSec = resolved
    }

    val fullDurationSec = fileDurationSec
    val showFullTimeline = hlsMode && fullDurationSec > 0

    val exo = remember {
        ExoPlayer.Builder(context)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus= */ true,
            )
            .build()
    }

    DisposableEffect(exo) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) {
                isPlaying = playing
            }

            override fun onPlayerError(playbackException: androidx.media3.common.PlaybackException) {
                if (BuildConfig.DEBUG) {
                    Log.e(
                        "HomeCinemaPlayer",
                        "ExoPlayer error: ${playbackException.errorCodeName} ${playbackException.message}",
                        playbackException,
                    )
                }
                error = userFacingError(playbackException)
            }
        }
        exo.addListener(listener)
        onDispose { exo.removeListener(listener) }
    }

    DisposableEffect(Unit) {
        onDispose { PlayerKeyDispatcher.handler = null }
    }

    LaunchedEffect(isTv, tvOverlayVisible, scrubbing) {
        if (isTv && tvOverlayVisible && !scrubbing) {
            delay(10_000)
            tvOverlayVisible = false
        }
    }

    var attachedMediaKey by remember { mutableStateOf<String?>(null) }
    var switchingSession by remember { mutableStateOf(false) }

    fun currentFilePositionSec(): Double =
        if (showFullTimeline) {
            playbackStartSec + exo.currentPosition / 1000.0
        } else {
            exo.currentPosition / 1000.0
        }

    fun attachMedia(uri: String, hls: Boolean, force: Boolean = false) {
        val key = "$uri|$hls"
        if (!force && key == attachedMediaKey && exo.playbackState != Player.STATE_IDLE) {
            if (!exo.playWhenReady) {
                exo.playWhenReady = true
            }
            return
        }
        if (force) {
            attachedMediaKey = null
            exo.stop()
        }
        attachedMediaKey = key
        if (BuildConfig.DEBUG) {
            Log.i("HomeCinemaPlayer", "attachMedia hls=$hls uri=$uri force=$force")
        }
        val item = MediaItem.Builder()
            .setUri(uri)
            .apply {
                if (hls) setMimeType(MimeTypes.APPLICATION_M3U8)
            }
            .build()
        exo.setMediaItem(item)
        exo.prepare()
        if (force && hls) {
            exo.seekTo(0)
        }
        exo.playWhenReady = true
    }

    suspend fun replaceTranscodeSession(
        audioIndex: Int,
        startSec: Double,
        heightOverride: Int? = null,
    ) {
        if (state == null || !hlsMode || switchingSession) return
        switchingSession = true
        transcodeBusy = true
        transcodeError = null
        val prevSession = state.transcodeSessionId
        val height = heightOverride ?: videoHeight
        if (heightOverride != null) {
            videoHeight = heightOverride
        }
        try {
            if (prevSession != null) {
                runCatching { api.deleteTranscodeSession(prevSession) }
            }
            val res = api.createTranscodeSession(
                TranscodeSessionBody(
                    hash = hash,
                    fileIndex = fileIndex,
                    audioIndex = audioIndex,
                    startSec = startSec,
                    videoHeight = height,
                    replaceSessionId = prevSession,
                ),
            )
            val url = endpoints.absoluteMediaUrl(res.playbackUrl)
                ?: throw IllegalStateException("Нет URL перекодированного потока")
            selectedAudio = res.selectedAudioIndex
            val lengthBytes = res.fileLength ?: state.fileLengthBytes
            val resolvedDur = resolveFileDurationSec(
                res.durationSec ?: state.durationSec,
                lengthBytes,
            )
            if (resolvedDur > fileDurationSec) fileDurationSec = resolvedDur
            playerState = state.copy(
                playbackUrl = url,
                transcodeSessionId = res.sessionId,
                selectedAudioIndex = res.selectedAudioIndex,
                audioTracks = res.audioTracks,
                durationSec = res.durationSec ?: state.durationSec,
                fileLengthBytes = lengthBytes,
            )
            playbackStartSec = startSec
            timelineSec = startSec
            attachMedia(url, hls = true, force = true)
            exo.seekTo(0)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            transcodeError = userFacingError(e)
        } finally {
            transcodeBusy = false
            switchingSession = false
        }
    }

    DisposableEffect(Unit) {
        val appScope = (context.applicationContext as HomeCinemaApp).applicationScope
        onDispose {
            val ps = playerState
            val sid = ps?.transcodeSessionId
            exo.release()
            appScope.launch(Dispatchers.IO) {
                if (sid != null) {
                    runCatching { api.deleteTranscodeSession(sid) }
                }
                if (ps != null) {
                    runCatching {
                        api.playbackEnded(
                            hash,
                            PlaybackEndedBody(fileIds = listOf(fileIndex)),
                        )
                    }
                }
            }
        }
    }

    LaunchedEffect(state?.playbackUri(), state?.playbackMode) {
        val s = state ?: return@LaunchedEffect
        attachMedia(s.playbackUri(), hls = s.playbackMode != "direct")
    }

    TimelinePositionEffect(
        enabled = showFullTimeline,
        scrubbing = scrubbing,
        transcodeBusy = transcodeBusy,
        playbackStartSec = playbackStartSec,
        exo = exo,
        onPositionSec = { timelineSec = it },
    )

    DisposableEffect(isFullscreen) {
        val window = (view.context as Activity).window
        val controller = WindowCompat.getInsetsController(window, view)
        if (isFullscreen) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
        onDispose {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    BackHandler(enabled = isTv) {
        onBack()
    }

    BackHandler(enabled = isFullscreen && !isTv) {
        if (fullscreenControlsVisible) {
            playerViewRef.value?.hideController()
        } else {
            isFullscreen = false
        }
    }

    LaunchedEffect(isFullscreen, isTv) {
        if (isFullscreen && !isTv) {
            playerViewRef.value?.hideController()
            fullscreenControlsVisible = false
        }
    }

    val immersive = isFullscreen || isTv

    fun showPhoneFullscreenOverlay() {
        fullscreenControlsVisible = true
        playerViewRef.value?.showController()
    }

    fun onFullTimelineScrubStart() {
        scrubbing = true
        if (isTv) {
            tvOverlayVisible = true
            playerViewRef.value?.showController()
        } else if (isFullscreen) {
            showPhoneFullscreenOverlay()
        }
    }

    val phoneFullscreenTimelineVisible =
        isFullscreen && !isTv && (fullscreenControlsVisible || scrubbing || transcodeBusy)

    fun handleTvPreviewKey(event: androidx.compose.ui.input.key.KeyEvent): Boolean {
        if (event.type != KeyEventType.KeyDown) return false
        val pv = playerViewRef.value
        when (event.key) {
            Key.DirectionUp, Key.DirectionDown -> {
                tvOverlayVisible = true
                pv?.showController()
                return false
            }
            Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> {
                if (!tvOverlayVisible && pv != null) {
                    if (exo.isPlaying) exo.pause() else exo.play()
                    tvOverlayVisible = true
                    pv.showController()
                    return true
                }
                pv?.showController()
                return false
            }
            Key.DirectionLeft -> {
                if (!tvOverlayVisible && !showFullTimeline) {
                    exo.seekTo((exo.currentPosition - 10_000).coerceAtLeast(0))
                    return true
                }
            }
            Key.DirectionRight -> {
                if (!tvOverlayVisible && !showFullTimeline) {
                    val maxPos = exo.duration.takeIf { it > 0 } ?: Long.MAX_VALUE
                    exo.seekTo((exo.currentPosition + 10_000).coerceAtMost(maxPos))
                    return true
                }
            }
            else -> Unit
        }
        return false
    }

    if (immersive && state != null && !preparing && error == null) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .focusable()
                .onPreviewKeyEvent { handleTvPreviewKey(it) },
        ) {
            key(state.playbackUri()) {
                PlayerViewHost(
                    exo = exo,
                    hideBuiltInSeek = showFullTimeline,
                    useTextureSurface = isTv,
                    isTv = isTv,
                    requestFocus = true,
                    onPlayerViewReady = { view ->
                        playerViewRef.value = view
                        if (isTv) {
                            PlayerKeyDispatcher.handler = { event -> view.dispatchKeyEvent(event) }
                        }
                    },
                    onControllerVisibility = { visible ->
                        fullscreenControlsVisible = visible
                        if (visible) tvOverlayVisible = true
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            AnimatedVisibility(
                visible = !isTv && fullscreenControlsVisible,
                enter = fadeIn(),
                exit = fadeOut(),
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(12.dp),
            ) {
                SecondaryButton(
                    text = "Выйти из полного экрана",
                    onClick = { isFullscreen = false },
                )
            }
            AnimatedVisibility(
                visible = isTv && tvOverlayVisible,
                enter = fadeIn(),
                exit = fadeOut(),
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(Color.Black.copy(alpha = 0.78f))
                    .padding(16.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        state.title,
                        style = MaterialTheme.typography.titleMedium,
                        color = Color.White,
                    )
                    Text(
                        state.fileName,
                        color = HomeMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (showFullTimeline) {
                        FullFileTimeline(
                            timelineSec = timelineSec,
                            fullDurationSec = fullDurationSec,
                            transcodeBusy = transcodeBusy,
                            scrubbing = scrubbing,
                            onScrubStart = { onFullTimelineScrubStart() },
                            onScrub = { timelineSec = it },
                            onScrubEnd = { target ->
                                scrubbing = false
                                scope.launch {
                                    replaceTranscodeSession(selectedAudio, target)
                                }
                            },
                        )
                    }
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.focusRequester(tvControlsFocus),
                    ) {
                        SecondaryButton(text = "Назад", onClick = onBack)
                        PrimaryButton(
                            text = if (isPlaying) "Пауза" else "Play",
                            onClick = {
                                if (exo.isPlaying) exo.pause() else exo.play()
                            },
                        )
                        SecondaryButton(
                            text = "−10 сек",
                            onClick = {
                                exo.seekTo((exo.currentPosition - 10_000).coerceAtLeast(0))
                            },
                        )
                        SecondaryButton(
                            text = "+10 сек",
                            onClick = {
                                val maxPos = exo.duration.takeIf { it > 0 } ?: Long.MAX_VALUE
                                exo.seekTo((exo.currentPosition + 10_000).coerceAtMost(maxPos))
                            },
                        )
                    }
                    Text(
                        "OK — пауза/пуск · ↑↓ — панель · ←→ — ±10 сек (или шкала для HLS)",
                        color = HomeMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            LoadingOverlay(
                visible = transcodeBusy,
                message = "Перемотка: перекодирование…",
            )
            AnimatedVisibility(
                visible = showFullTimeline && phoneFullscreenTimelineVisible,
                enter = fadeIn(),
                exit = fadeOut(),
                modifier = Modifier.align(Alignment.BottomCenter),
            ) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(Color.Black.copy(alpha = 0.72f))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    FullFileTimeline(
                        timelineSec = timelineSec,
                        fullDurationSec = fullDurationSec,
                        transcodeBusy = transcodeBusy,
                        scrubbing = scrubbing,
                        onScrubStart = { onFullTimelineScrubStart() },
                        onScrub = { timelineSec = it },
                        onScrubEnd = { target ->
                            scrubbing = false
                            scope.launch {
                                replaceTranscodeSession(selectedAudio, target)
                            }
                        },
                    )
                }
            }
        }
        LaunchedEffect(tvOverlayVisible) {
            if (isTv && tvOverlayVisible) {
                tvControlsFocus.requestFocus()
            }
        }
        return
    }

    Column(Modifier.fillMaxSize()) {
        SecondaryButton(text = "Назад", onClick = onBack, modifier = Modifier.padding(12.dp))
        when {
            preparing -> {
                PlaySelectProgressPanel(
                    status = bootstrapStatus,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
            error != null -> Text(error!!, color = HomeError, modifier = Modifier.padding(12.dp))
            state != null -> {
                Text(state.title, modifier = Modifier.padding(horizontal = 12.dp))
                Text(state.fileName, color = HomeMuted, modifier = Modifier.padding(horizontal = 12.dp))
                if (hlsMode) {
                    Text(
                        "Перекодирование для устройства",
                        color = HomeMuted,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
                transcodeError?.let {
                    Text(it, color = HomeError, modifier = Modifier.padding(horizontal = 12.dp))
                }
                if (showFullTimeline) {
                    FullFileTimeline(
                        timelineSec = timelineSec,
                        fullDurationSec = fullDurationSec,
                        transcodeBusy = transcodeBusy,
                        scrubbing = scrubbing,
                        onScrubStart = { onFullTimelineScrubStart() },
                        onScrub = { timelineSec = it },
                        onScrubEnd = { target ->
                            scrubbing = false
                            scope.launch {
                                replaceTranscodeSession(selectedAudio, target)
                            }
                        },
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                    Text(
                        "Полная длительность файла. Перемотка перезапускает перекодирование с выбранной позиции.",
                        color = HomeMuted,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
                    )
                }
                var qualityExpanded by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(
                    expanded = qualityExpanded,
                    onExpandedChange = { expanded ->
                        if (!transcodeBusy) qualityExpanded = expanded
                    },
                    modifier = Modifier
                        .padding(horizontal = 12.dp, vertical = 4.dp)
                        .fillMaxWidth(),
                ) {
                    OutlinedTextField(
                        readOnly = true,
                        enabled = !transcodeBusy,
                        value = qualityOptions.firstOrNull { it.first == videoHeight }?.second ?: "Авто",
                        onValueChange = {},
                        label = { Text("Качество") },
                        trailingIcon = {
                            ExposedDropdownMenuDefaults.TrailingIcon(expanded = qualityExpanded)
                        },
                        colors = homeTextFieldColors(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(),
                    )
                    ExposedDropdownMenu(
                        expanded = qualityExpanded,
                        onDismissRequest = { qualityExpanded = false },
                    ) {
                        qualityOptions.forEach { (h, label) ->
                            DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    qualityExpanded = false
                                    if (h == videoHeight) return@DropdownMenuItem
                                    videoHeight = h
                                    if (hlsMode) {
                                        scope.launch {
                                            replaceTranscodeSession(
                                                selectedAudio,
                                                currentFilePositionSec(),
                                                heightOverride = h,
                                            )
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
                val tracks = state.audioTracks
                if (tracks.size > 1 && hlsMode) {
                    AudioTrackDropdown(
                        tracks = tracks,
                        selectedIndex = selectedAudio,
                        enabled = !transcodeBusy,
                        onSelect = { idx ->
                            scope.launch {
                                replaceTranscodeSession(idx, currentFilePositionSec())
                            }
                        },
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
                Box(
                    Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(horizontal = 12.dp),
                ) {
                    key(state.playbackUri()) {
                        PlayerViewHost(
                            exo = exo,
                            hideBuiltInSeek = showFullTimeline,
                            useTextureSurface = false,
                            isTv = false,
                            onPlayerViewReady = { playerViewRef.value = it },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    LoadingOverlay(
                        visible = transcodeBusy,
                        message = "Перемотка: перекодирование…",
                    )
                }
                Row(
                    Modifier.padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    PrimaryButton(text = "На весь экран", onClick = { isFullscreen = true })
                }
            }
        }
    }
}

@Composable
private fun AudioTrackDropdown(
    tracks: List<AudioTrackInfo>,
    selectedIndex: Int,
    enabled: Boolean,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = tracks.firstOrNull { it.index == selectedIndex }?.label
        ?: tracks.firstOrNull()?.label.orEmpty()

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { next -> if (enabled) expanded = next },
        modifier = modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = selectedLabel,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text("Озвучка") },
            trailingIcon = {
                ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded)
            },
            colors = homeTextFieldColors(),
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            tracks.forEach { tr ->
                DropdownMenuItem(
                    text = { Text(tr.label) },
                    onClick = {
                        expanded = false
                        if (tr.index != selectedIndex) {
                            onSelect(tr.index)
                        }
                    },
                )
            }
        }
    }
}

/** Updates timeline without recomposing [PlayerViewHost] (runs outside composition clock). */
@Composable
private fun TimelinePositionEffect(
    enabled: Boolean,
    scrubbing: Boolean,
    transcodeBusy: Boolean,
    playbackStartSec: Double,
    exo: ExoPlayer,
    onPositionSec: (Double) -> Unit,
) {
    val scrubbingState = rememberUpdatedState(scrubbing)
    val transcodeBusyState = rememberUpdatedState(transcodeBusy)
    val startSecState = rememberUpdatedState(playbackStartSec)
    LaunchedEffect(enabled, exo) {
        if (!enabled) return@LaunchedEffect
        while (isActive) {
            if (
                !scrubbingState.value &&
                !transcodeBusyState.value &&
                exo.playbackState == Player.STATE_READY
            ) {
                onPositionSec(startSecState.value + exo.currentPosition / 1000.0)
            }
            delay(400)
        }
    }
}

@Composable
private fun FullFileTimeline(
    timelineSec: Double,
    fullDurationSec: Double,
    transcodeBusy: Boolean,
    scrubbing: Boolean,
    onScrubStart: () -> Unit,
    onScrub: (Double) -> Unit,
    onScrubEnd: (Double) -> Unit,
    modifier: Modifier = Modifier,
) {
    var sliderValue by remember(fullDurationSec) {
        mutableFloatStateOf(timelineSec.toFloat().coerceIn(0f, fullDurationSec.toFloat()))
    }
    LaunchedEffect(timelineSec, transcodeBusy, scrubbing) {
        if (!transcodeBusy && !scrubbing) {
            sliderValue = timelineSec.toFloat().coerceIn(0f, fullDurationSec.toFloat())
        }
    }
    Row(
        modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            formatPlaybackTime(timelineSec),
            style = MaterialTheme.typography.bodySmall,
            color = HomeTextPrimary,
        )
        Slider(
            value = sliderValue.coerceIn(0f, fullDurationSec.toFloat()),
            onValueChange = { v ->
                sliderValue = v
                onScrubStart()
                onScrub(v.toDouble())
            },
            onValueChangeFinished = {
                val target = sliderValue.toDouble().coerceIn(0.0, fullDurationSec)
                onScrubEnd(target)
            },
            valueRange = 0f..fullDurationSec.toFloat(),
            enabled = !transcodeBusy,
            modifier = Modifier.weight(1f),
        )
        Text(
            formatPlaybackTime(fullDurationSec),
            style = MaterialTheme.typography.bodySmall,
            color = HomeTextPrimary,
        )
    }
}

@Composable
private fun PlayerViewHost(
    exo: ExoPlayer,
    hideBuiltInSeek: Boolean,
    useTextureSurface: Boolean,
    isTv: Boolean,
    modifier: Modifier = Modifier,
    requestFocus: Boolean = false,
    onPlayerViewReady: (PlayerView) -> Unit = {},
    onControllerVisibility: (Boolean) -> Unit = {},
) {
    val hideSeekState = rememberUpdatedState(hideBuiltInSeek)
    val lastHideSeekApplied = remember { mutableStateOf<Boolean?>(null) }
    AndroidView(
        factory = { ctx ->
            val playerView = if (useTextureSurface) {
                LayoutInflater.from(ctx)
                    .inflate(R.layout.player_view_texture, null, false) as PlayerView
            } else {
                PlayerView(ctx)
            }
            playerView.apply {
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                player = exo
                useController = true
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                controllerHideOnTouch = !isTv
                controllerShowTimeoutMs = if (isTv) 12_000 else 4_000
                isFocusable = true
                isFocusableInTouchMode = true
                setControllerVisibilityListener(
                    PlayerView.ControllerVisibilityListener { visibility ->
                        onControllerVisibility(visibility == View.VISIBLE)
                    },
                )
                enableComposeSurfaceSyncWorkaroundIfAvailable()
                applyBuiltInSeekVisibility(this, hideSeekState.value)
                onPlayerViewReady(this)
                if (requestFocus || isTv) {
                    post {
                        requestFocus()
                        if (isTv) showController()
                    }
                }
            }
        },
        update = { playerView ->
            val hide = hideSeekState.value
            if (lastHideSeekApplied.value != hide) {
                lastHideSeekApplied.value = hide
                applyBuiltInSeekVisibility(playerView, hide)
            }
        },
        onRelease = { playerView ->
            playerView.player = null
        },
        modifier = modifier,
    )
}

private fun applyBuiltInSeekVisibility(playerView: PlayerView, hideBuiltInSeek: Boolean) {
    val seekVis = if (hideBuiltInSeek) View.GONE else View.VISIBLE
    listOf(
        androidx.media3.ui.R.id.exo_progress,
        androidx.media3.ui.R.id.exo_position,
        androidx.media3.ui.R.id.exo_duration,
    ).forEach { id ->
        playerView.findViewById<View>(id)?.visibility = seekVis
    }
}

private fun PlayerView.enableComposeSurfaceSyncWorkaroundIfAvailable() {
    runCatching {
        val method = PlayerView::class.java.getMethod(
            "setEnableComposeSurfaceSyncWorkaround",
            Boolean::class.javaPrimitiveType,
        )
        method.invoke(this, true)
    }
}
