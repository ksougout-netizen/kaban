/* ============================================================================
   KABAN — Service Worker: только то, что нужно для Web Push уведомлений,
   когда вкладка с приложением ЗАКРЫТА. Ничего не кэширует, не работает как
   offline-прокси — это осознанно, чтобы не усложнять и не рисковать
   показом устаревшей версии приложения (см. cache-busting ?v= у script.js/
   style.css в index.html, той же идее здесь ничего не мешает).
   ========================================================================= */

self.addEventListener("install", (event) => {
    // Не ждём закрытия старых вкладок — новый Service Worker должен начать
    // обрабатывать push сразу после установки.
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

// Сама доставка push — событие приходит от браузера ПОСЛЕ того, как push-
// служба (FCM/Mozilla push и т.п.) разбудила его по подписке (см.
// push_subscriptions в schema.sql и Edge Function send-push, которая шлёт
// сюда payload). Работает даже если ни одна вкладка приложения не открыта.
self.addEventListener("push", (event) => {

    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (error) {
        payload = { title: "KABAN", body: event.data ? event.data.text() : "Новое сообщение" };
    }

    const title = payload.title || "KABAN";
    const options = {
        body: payload.body || "Новое сообщение",
        icon: payload.icon || undefined,
        tag: payload.tag || undefined,
        data: { chatId: payload.chatId || null, url: payload.url || self.registration.scope }
    };

    event.waitUntil(self.registration.showNotification(title, options));

});

// Клик по уведомлению — фокусируем уже открытую вкладку приложения, если
// есть, иначе открываем новую. chatId прокидываем в открытую страницу
// через postMessage, script.js слушает его и открывает нужный чат (см.
// "message" listener в script.js рядом с startInboxSubscription).
self.addEventListener("notificationclick", (event) => {

    event.notification.close();
    const chatId = event.notification.data?.chatId;
    // scope — адрес самого приложения (на GitHub Pages это подпапка, не корень сайта).
    const targetUrl = event.notification.data?.url || self.registration.scope;

    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ("focus" in client) {
                    client.focus();
                    if (chatId) client.postMessage({ type: "open-chat", chatId });
                    return;
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow(chatId ? `${targetUrl}#chat=${chatId}` : targetUrl);
            }
        })
    );

});
