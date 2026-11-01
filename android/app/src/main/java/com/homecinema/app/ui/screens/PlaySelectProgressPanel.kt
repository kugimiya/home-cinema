package com.homecinema.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import com.homecinema.app.ui.components.HomeLoadingIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.homecinema.app.data.api.PlaySelectStatus
import com.homecinema.app.data.api.formatBytes
import com.homecinema.app.data.api.formatSpeed
import com.homecinema.app.ui.theme.HomeMuted

@Composable
fun PlaySelectProgressPanel(
    status: PlaySelectStatus,
    modifier: Modifier = Modifier,
) {
    val step = status.step ?: 1
    val stepTotal = status.stepTotal ?: 9
    val probePhase = status.phase == "probe"
    val probeTarget = status.probeBytesTarget ?: 0L
    val probeGot = status.probeBytesDownloaded ?: 0L

    Column(modifier) {
        Text(
            "Запуск воспроизведения",
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        Text(
            "Этап $step из $stepTotal",
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            status.message ?: "Подготовка…",
            modifier = Modifier.padding(top = 6.dp),
        )
        if (probePhase && probeTarget > 0) {
            val speed = formatSpeed(status.probeDownloadSpeed)
            val peers = status.probeTotalPeers
            val elapsed = status.probeElapsedSec
            val extra = buildList {
                add("${formatBytes(probeGot)} / ${formatBytes(probeTarget)}")
                if (speed != null) add("качается $speed")
                if (peers != null) add("пиры: $peers")
                if (elapsed != null && elapsed > 0) add("ffprobe: ${elapsed.toInt()} с")
            }.joinToString(" · ")
            Text(
                "С начала файла: $extra",
                color = HomeMuted,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        HomeLoadingIndicator(
            modifier = Modifier.padding(top = 16.dp),
            message = null,
        )
    }
}
