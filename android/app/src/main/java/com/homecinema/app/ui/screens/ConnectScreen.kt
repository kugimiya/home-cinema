package com.homecinema.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.homecinema.app.data.ServerEndpoints
import com.homecinema.app.data.discovery.ServerDiscovery
import com.homecinema.app.ui.components.PrimaryButton
import com.homecinema.app.ui.components.SecondaryButton
import com.homecinema.app.ui.theme.HomeError
import com.homecinema.app.ui.theme.HomeLink
import com.homecinema.app.ui.theme.HomeMuted
import com.homecinema.app.ui.theme.homeTextFieldColors
import com.homecinema.app.ui.util.userFacingError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun ConnectScreen(
    discovery: ServerDiscovery,
    onConnected: (ServerEndpoints) -> Unit,
) {
    val defaultApi = remember {
        val emulator = Build.FINGERPRINT.contains("generic", ignoreCase = true) ||
            Build.HARDWARE.contains("goldfish", ignoreCase = true) ||
            Build.HARDWARE.contains("ranchu", ignoreCase = true) ||
            Build.PRODUCT.contains("sdk", ignoreCase = true)
        if (emulator) "http://10.0.2.2:8080" else "http://192.168.1.5:8080"
    }
    var manualUrl by remember { mutableStateOf(defaultApi) }
    var scanning by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun connect(endpoints: ServerEndpoints) {
        error = null
        onConnected(endpoints)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Home Cinema", style = androidx.compose.material3.MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "Подключение к серверу в локальной сети",
            color = HomeMuted,
        )
        Spacer(Modifier.height(24.dp))

        if (scanning) {
            CircularProgressIndicator(color = HomeLink)
            Spacer(Modifier.height(12.dp))
            Text("Ищем orchestrator (mDNS и сканирование подсети)…", color = HomeMuted)
        } else {
            PrimaryButton(
                text = "Найти автоматически",
                onClick = {
                    scanning = true
                    error = null
                    scope.launch {
                        try {
                            val found = discovery.findServer()
                            if (found != null) {
                                connect(found)
                            } else {
                                error = "Сервер не найден. Укажите адрес вручную или проверьте, что Docker запущен и порт 8080 открыт в LAN."
                            }
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = userFacingError(e)
                        } finally {
                            scanning = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(0.85f),
            )
        }

        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = manualUrl,
            onValueChange = { manualUrl = it },
            label = { Text("Адрес API (orchestrator)") },
            placeholder = { Text("http://192.168.x.x:8080") },
            colors = homeTextFieldColors(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = {}),
            modifier = Modifier.fillMaxWidth(0.85f),
        )
        Spacer(Modifier.height(12.dp))
        SecondaryButton(
            text = "Подключить",
            onClick = {
                scope.launch {
                    scanning = true
                    error = null
                    try {
                        val endpoints = discovery.probeApiBase(manualUrl)
                        if (endpoints != null) {
                            connect(endpoints)
                        } else {
                            error = "Не удалось связаться с /api/discover по этому адресу."
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = userFacingError(e)
                    } finally {
                        scanning = false
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(0.85f),
        )

        error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = HomeError, modifier = Modifier.fillMaxWidth(0.85f))
        }
    }
}
