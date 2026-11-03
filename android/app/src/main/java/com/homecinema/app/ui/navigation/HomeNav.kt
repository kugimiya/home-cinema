package com.homecinema.app.ui.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.homecinema.app.data.ServerEndpoints
import com.homecinema.app.data.ServerStore
import com.homecinema.app.data.api.HomeCinemaApi
import com.homecinema.app.data.api.Release
import com.homecinema.app.data.api.createApi
import com.homecinema.app.data.discovery.ServerDiscovery
import com.homecinema.app.ui.components.TabChip
import com.homecinema.app.ui.screens.ConnectScreen
import com.homecinema.app.ui.screens.LibraryScreen
import com.homecinema.app.ui.screens.PlayerScreen
import com.homecinema.app.ui.screens.SearchScreen
import com.homecinema.app.ui.screens.ServiceStatusBar
import com.homecinema.app.ui.screens.WatchPrepareScreen
import com.homecinema.app.ui.screens.WatchSelectScreen
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

object Routes {
    const val Connect = "connect"
    const val Main = "main/{tab}"
    const val WatchPrepare = "watch/prepare/{provider}/{externalId}"
    const val WatchSelect = "watch/{hash}"
    const val Player = "player/{hash}/{fileIndex}"

    fun main(tab: String) = "main/$tab"
}

@Composable
fun HomeNav(
    serverStore: ServerStore,
    discovery: ServerDiscovery,
) {
    val nav = rememberNavController()
    val endpoints by serverStore.endpoints.collectAsState(initial = null)
    var pendingConnect by remember { mutableStateOf<ServerEndpoints?>(null) }
    var pendingClearServer by remember { mutableStateOf(false) }

    LaunchedEffect(pendingConnect) {
        val ep = pendingConnect ?: return@LaunchedEffect
        serverStore.save(ep)
        pendingConnect = null
        nav.navigate(Routes.main("search")) {
            popUpTo(Routes.Connect) { inclusive = true }
            launchSingleTop = true
        }
    }

    LaunchedEffect(pendingClearServer) {
        if (!pendingClearServer) return@LaunchedEffect
        serverStore.clear()
        pendingClearServer = false
        nav.navigate(Routes.Connect) { popUpTo(0) }
    }

    LaunchedEffect(endpoints) {
        if (endpoints == null) return@LaunchedEffect
        val onConnect = nav.currentBackStackEntry?.destination?.route == Routes.Connect
        if (!onConnect) return@LaunchedEffect
        nav.navigate(Routes.main("search")) {
            popUpTo(Routes.Connect) { inclusive = true }
            launchSingleTop = true
        }
    }

    NavHost(navController = nav, startDestination = Routes.Connect) {
        composable(Routes.Connect) {
            ConnectScreen(discovery = discovery) { ep ->
                pendingConnect = ep
            }
        }

        composable(
            Routes.Main,
            arguments = listOf(navArgument("tab") { defaultValue = "search" }),
        ) { entry ->
            val ep = endpoints ?: run {
                nav.navigate(Routes.Connect) { popUpTo(0) }
                return@composable
            }
            val api = remember(ep) { createApi(ep) }
            val tab = entry.arguments?.getString("tab") ?: "search"
            MainShell(
                api = api,
                endpoints = ep,
                tab = tab,
                onTab = { t -> nav.navigate(Routes.main(t)) { launchSingleTop = true } },
                onWatchRelease = { r ->
                    val enc = URLEncoder.encode(r.externalId, StandardCharsets.UTF_8.toString())
                    nav.navigate("watch/prepare/${r.provider}/$enc")
                },
                onWatchHash = { h -> nav.navigate("watch/${URLEncoder.encode(h, StandardCharsets.UTF_8.toString())}") },
                onPlayFile = { h, idx ->
                    nav.navigate("player/$h/$idx")
                },
                onChangeServer = { pendingClearServer = true },
            )
        }

        composable(
            Routes.WatchPrepare,
            arguments = listOf(
                navArgument("provider") { type = NavType.StringType },
                navArgument("externalId") { type = NavType.StringType },
            ),
        ) { entry ->
            val ep = endpoints ?: return@composable
            val api = remember(ep) { createApi(ep) }
            val provider = entry.arguments?.getString("provider") ?: return@composable
            val externalId = entry.arguments?.getString("externalId") ?: return@composable
            WatchPrepareScreen(
                api = api,
                provider = provider,
                externalId = externalId,
                onReady = { hash ->
                    nav.navigate("watch/$hash") {
                        popUpTo(Routes.main("search")) { inclusive = false }
                    }
                },
                onBack = { nav.popBackStack() },
            )
        }

        composable(
            Routes.WatchSelect,
            arguments = listOf(navArgument("hash") { type = NavType.StringType }),
        ) { entry ->
            val ep = endpoints ?: return@composable
            val api = remember(ep) { createApi(ep) }
            val hash = entry.arguments?.getString("hash")?.lowercase() ?: return@composable
            WatchSelectScreen(
                api = api,
                hash = hash,
                onPlayFile = { idx -> nav.navigate("player/$hash/$idx") },
                onBack = { nav.popBackStack() },
            )
        }

        composable(
            Routes.Player,
            arguments = listOf(
                navArgument("hash") { type = NavType.StringType },
                navArgument("fileIndex") { type = NavType.IntType },
            ),
        ) { entry ->
            val ep = endpoints ?: return@composable
            val api = remember(ep) { createApi(ep) }
            val hash = entry.arguments?.getString("hash")?.lowercase() ?: return@composable
            val fileIndex = entry.arguments?.getInt("fileIndex") ?: return@composable
            PlayerScreen(
                api = api,
                endpoints = ep,
                hash = hash,
                fileIndex = fileIndex,
                initialState = null,
                onBack = { nav.popBackStack() },
                onSwitchFile = { idx ->
                    nav.navigate("player/$hash/$idx") {
                        launchSingleTop = true
                    }
                },
            )
        }
    }
}

@Composable
private fun MainShell(
    api: HomeCinemaApi,
    endpoints: ServerEndpoints,
    tab: String,
    onTab: (String) -> Unit,
    onWatchRelease: (Release) -> Unit,
    onWatchHash: (String) -> Unit,
    onPlayFile: (hash: String, fileIndex: Int) -> Unit,
    onChangeServer: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(16.dp),
    ) {
        androidx.compose.foundation.layout.Row(
            horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp),
        ) {
            TabChip("Поиск", tab == "search", { onTab("search") })
            TabChip("Библиотека", tab == "library", { onTab("library") })
            com.homecinema.app.ui.components.SecondaryButton("Сервер", onChangeServer)
        }
        ServiceStatusBar(api, endpoints.apiBase)
        Box(Modifier.fillMaxSize().weight(1f)) {
            when (tab) {
                "library" -> LibraryScreen(api, endpoints.apiBase, onWatchHash, onPlayFile)
                else -> SearchScreen(api, onWatchRelease)
            }
        }
    }
}
