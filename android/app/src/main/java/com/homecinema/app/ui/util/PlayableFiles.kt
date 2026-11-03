package com.homecinema.app.ui.util

import com.homecinema.app.data.api.TorrentMediaFile

fun playableMediaFiles(files: List<TorrentMediaFile>): List<TorrentMediaFile> =
    files.filter { it.kind == "video" || it.kind == "audio" }

fun adjacentPlayableFile(
    files: List<TorrentMediaFile>,
    currentFileId: Int,
    direction: Int,
): TorrentMediaFile? {
    val list = playableMediaFiles(files)
    val idx = list.indexOfFirst { it.id == currentFileId }
    if (idx < 0) return null
    val next = idx + direction
    if (next !in list.indices) return null
    return list[next]
}
