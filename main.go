package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

//go:embed web
var webFiles embed.FS

var loadpointAction = regexp.MustCompile(`^/api/loadpoints/[1-9][0-9]*/(mode/(smart|now|pv|minpv)|alwayscharge/(on|off))$`)

func main() {
	port := flag.Int("port", 8080, "HTTP port for the web interface")
	evccAddress := flag.String("evcc", envOr("EVCC_URL", "http://127.0.0.1:7070"), "evcc base URL")
	flag.Parse()

	if *port < 1 || *port > 65535 {
		log.Fatal("port must be between 1 and 65535")
	}
	upstream, err := url.Parse(*evccAddress)
	if err != nil || (upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.Host == "" {
		log.Fatal("evcc must be an absolute http:// or https:// URL")
	}
	if upstream.Path != "" && upstream.Path != "/" {
		log.Fatal("evcc URL must not include a path")
	}

	handler, err := newHandler(upstream)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", *port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("evcc display listening on %s, proxying API requests to %s", server.Addr, upstream)
	log.Fatal(server.ListenAndServe())
}

func newHandler(upstream *url.URL) (http.Handler, error) {
	staticFiles, err := fs.Sub(webFiles, "web")
	if err != nil {
		return nil, fmt.Errorf("load embedded web files: %w", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		log.Printf("evcc proxy error: %v", err)
		http.Error(w, "evcc is unavailable", http.StatusBadGateway)
	}
	files := http.FileServer(http.FS(staticFiles))

	mux := http.NewServeMux()
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if !allowedAPIRequest(r) {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
	mux.Handle("/", files)
	return mux, nil
}

func allowedAPIRequest(r *http.Request) bool {
	if r.URL.Path == "/api/state" {
		return r.Method == http.MethodGet && len(r.URL.RawQuery) <= 8192
	}
	return r.Method == http.MethodPost && loadpointAction.MatchString(r.URL.Path) && r.URL.RawQuery == ""
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
