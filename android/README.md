# Home Cinema — Android / Android TV

Клиент с тем же сценарием, что и веб: **Поиск**, **Библиотека**, подготовка торрента, выбор файла, **ExoPlayer** (direct + HLS transcode).

- **minSdk 31** — Android 12 (TV) и новее  
- **targetSdk 35** по умолчанию — отладка на планшете с Android 16  
- Сборка **под Android 12 (TV)**: `targetSdk 31` через `-PANDROID_TARGET_SDK=31` (см. ниже)  
- Лаунчер: обычный **LAUNCHER** (планшет/телефон) и **LEANBACK_LAUNCHER** (TV)

## Подключение к серверу

1. ПК с Docker в той же Wi‑Fi/LAN, что и устройство.  
2. В `.env` на хосте замените `localhost` на LAN‑IP ПК (для URL потоков):

   ```env
   ORCHESTRATOR_PUBLIC_URL=http://192.168.x.x:3000
   TORRENT_ENGINE_PUBLIC_URL=http://192.168.x.x:3000
   ```

   Порты **8080** (API) и **3000** (nginx `/stream`) должны быть доступны с планшета/TV.

3. В приложении: **«Найти автоматически»** (mDNS `_homecinema._tcp` + скан `/24` на `:8080`) или вручную `http://192.168.x.x:8080`.

Orchestrator отдаёт `GET /api/discover` с подсказками URL для переписывания `localhost` в ответах API.

## Сборка

1. [Android Studio](https://developer.android.com/studio) (Ladybug или новее).  
2. **File → Open** → каталог `android/`.  
3. Планшет: Run ▶ на подключённом устройстве (USB debugging).  
4. TV: ADB по сети или эмулятор **Android TV (API 31+)**.

Gradle Wrapper подтянется при первой синхронизации.

### Сборка под Android 12 (TV, API 31)

Один APK ставится на Android 12+ (`minSdk 31`). Для варианта с **targetSdk 31** (типично для TV на Android 12):

```powershell
cd android
.\gradlew.bat assembleRelease -PANDROID_TARGET_SDK=31
# APK: app\build\outputs\apk\release\app-release.apk
```

Отладка на TV / эмуляторе API 31:

```powershell
.\gradlew.bat installDebug -PANDROID_TARGET_SDK=31
```

Планшет (Android 16) — как обычно, без параметра:

```powershell
.\gradlew.bat installDebug
```

В Android Studio: **Build → Edit Build Types / Gradle** или **Run → Edit Configurations → Gradle project** → добавьте в arguments: `-PANDROID_TARGET_SDK=31`.

SDK Platform **android-31** нужен в SDK Manager (`sdkmanager "platforms;android-31"`).

## Пульт / D-pad

Кнопки и поля — стандартный Compose focus order (вверх/вниз/OK). На TV используйте пульт; на планшете — тач и при необходимости клавиатуру.

## Ограничения v0.1

- Нет субтитров в плеере (как в базовом web direct).  
- Перезапуск Docker‑сервисов из UI не выведен (как на web без `SERVICE_RESTART_ENABLED`).  
- mDNS из контейнера Docker Desktop на Windows часто не виден — работает **скан подсети** или ручной адрес.
