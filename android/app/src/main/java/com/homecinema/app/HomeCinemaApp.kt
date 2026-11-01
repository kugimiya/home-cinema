package com.homecinema.app

import android.app.Application
import com.homecinema.app.data.ServerStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class HomeCinemaApp : Application() {
    lateinit var serverStore: ServerStore
        private set

    val applicationScope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        serverStore = ServerStore(this)
    }
}
