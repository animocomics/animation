// Harmless WebKitGTK probe: local static HTML only; no network or Shecan code.
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

static gint finish_timer = 0;

static gboolean quit_success(gpointer data) {
  GtkWidget *window = GTK_WIDGET(data);
  gtk_widget_destroy(window);
  return G_SOURCE_REMOVE;
}

static gboolean quit_failure(gpointer data) {
  g_print("NOMREH_GUI_PROBE_ERROR LOAD_TIMEOUT\n");
  gtk_widget_destroy(GTK_WIDGET(data));
  return G_SOURCE_REMOVE;
}

static void loaded(WebKitWebView *view, WebKitLoadEvent event, gpointer data) {
  (void)view;
  if (event != WEBKIT_LOAD_FINISHED) return;
  g_print("NOMREH_GUI_PROBE_WEBKIT_LOAD_FINISHED\n");
  g_print("NOMREH_GUI_PROBE_NO_NETWORK yes\n");
  g_print("NOMREH_GUI_PROBE_SHECAN_INCLUDED no\n");
  g_print("NOMREH_GUI_PROBE_PASS\n");
  g_timeout_add(1500, quit_success, data);
  if (finish_timer) g_source_remove(finish_timer);
  finish_timer = 0;
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(window), "Nomreh graphical VM probe");
  gtk_window_set_default_size(GTK_WINDOW(window), 1000, 700);
  g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), NULL);

  WebKitSettings *settings = webkit_settings_new();
  webkit_settings_set_enable_javascript(settings, FALSE);
  WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new_with_settings(settings));
  const char *html =
      "<!doctype html><html lang='fa' dir='rtl'><meta charset='utf-8'>"
      "<body style='margin:0;font-family:sans-serif;background:#f4f7fb;color:#15233b;"
      "display:grid;place-items:center;height:100vh'>"
      "<main style='padding:42px;text-align:center'><h1>آزمون گرافیکی نمره</h1>"
      "<p>اجرای واقعی WebKitGTK داخل ماشین مجازی</p>"
      "<p>بدون شبکه و بدون برنامهٔ شکن</p></main></body></html>";
  g_signal_connect(view, "load-changed", G_CALLBACK(loaded), window);
  webkit_web_view_load_html(view, html, NULL);
  gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
  gtk_widget_show_all(window);
  finish_timer = g_timeout_add_seconds(25, quit_failure, window);
  gtk_main();
  return 0;
}
