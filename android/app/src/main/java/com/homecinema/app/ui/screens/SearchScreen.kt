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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.homecinema.app.data.api.HomeCinemaApi
import com.homecinema.app.data.api.Release
import com.homecinema.app.ui.components.LoadingOverlay
import com.homecinema.app.ui.components.PrimaryButton
import com.homecinema.app.ui.theme.HomeError
import com.homecinema.app.ui.theme.HomeMuted
import com.homecinema.app.ui.theme.homeTextFieldColors
import com.homecinema.app.ui.util.userFacingError
import android.util.Log
import com.homecinema.app.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun SearchScreen(
    api: HomeCinemaApi,
    onWatch: (Release) -> Unit,
) {
    var query by remember { mutableStateOf("назад в будущее") }
    var source by remember { mutableStateOf<String?>(null) }
    var releases by remember { mutableStateOf<List<Release>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun runSearch() {
        val q = query.trim()
        if (q.isEmpty()) return
        scope.launch {
            loading = true
            error = null
            try {
                val data = api.search(q)
                source = data.source
                releases = data.releases
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) {
                    Log.e("HomeCinema", "search failed q=$q", e)
                }
                error = userFacingError(e)
            } finally {
                loading = false
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Text("Поиск", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
        Row(
            Modifier.fillMaxWidth().padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Название фильма или сериала") },
                colors = homeTextFieldColors(),
                singleLine = true,
            )
            PrimaryButton(
                text = "Найти",
                enabled = !loading,
                onClick = { runSearch() },
            )
        }
        source?.let {
            Text(
                "Источник: ${if (it == "torapi") "TorAPI" else "RuTor"} · ${releases.size} результатов",
                color = HomeMuted,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        error?.let { Text(it, color = HomeError) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(releases, key = { "${it.provider}-${it.externalId}" }) { r ->
                    ReleaseRow(release = r, onWatch = { onWatch(r) })
                }
            }
            LoadingOverlay(
                visible = loading,
                message = "Поиск релизов…",
            )
        }
    }
}

@Composable
private fun ReleaseRow(release: Release, onWatch: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(8.dp),
    ) {
        Text(release.title, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
        Text(
            listOfNotNull(release.quality, release.voice, release.size)
                .joinToString(" · ")
                .ifEmpty { "—" },
            color = HomeMuted,
        )
        Text("S/L: ${release.seeds ?: "?"}/${release.peers ?: "?"}", color = HomeMuted)
        PrimaryButton(text = "Смотреть", onClick = onWatch, modifier = Modifier.padding(top = 6.dp))
    }
}
