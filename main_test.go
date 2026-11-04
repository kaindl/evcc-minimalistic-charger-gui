package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestAllowedAPIRequest(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		query  string
		want   bool
	}{
		{"state query", http.MethodGet, "/api/state", "jq=%7B%7D", true},
		{"state post", http.MethodPost, "/api/state", "", false},
		{"mode post", http.MethodPost, "/api/loadpoints/2/mode/now", "", true},
		{"always-charge post", http.MethodPost, "/api/loadpoints/1/alwayscharge/off", "", true},
		{"mode get", http.MethodGet, "/api/loadpoints/1/mode/now", "", false},
		{"unknown endpoint", http.MethodPost, "/api/config", "", false},
		{"invalid loadpoint", http.MethodPost, "/api/loadpoints/0/mode/now", "", false},
		{"post query", http.MethodPost, "/api/loadpoints/1/mode/now", "anything=1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequest(tt.method, tt.path+"?"+tt.query, nil)
			if got := allowedAPIRequest(request); got != tt.want {
				t.Fatalf("allowedAPIRequest() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHandlerProxiesApprovedAPIRequests(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/state" || r.URL.Query().Get("jq") != "{}" {
			t.Errorf("unexpected upstream request: %s", r.URL)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"lps":[]}`))
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler, err := newHandler(target)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/state?jq=%7B%7D", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"lps":[]`) {
		t.Fatalf("unexpected proxy response: %d %q", response.Code, response.Body.String())
	}
}

func TestHandlerServesEmbeddedIndex(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:7070")
	handler, err := newHandler(target)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `id="display"`) {
		t.Fatalf("unexpected index response: %d", response.Code)
	}
}
