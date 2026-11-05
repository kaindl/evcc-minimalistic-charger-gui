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
		{"off mode post", http.MethodPost, "/api/loadpoints/2/mode/off", "", true},
		{"always-charge post", http.MethodPost, "/api/loadpoints/1/alwayscharge/off", "", true},
		{"vehicle selection post", http.MethodPost, "/api/loadpoints/2/vehicle/my-car", "", true},
		{"vehicle selection invalid name", http.MethodPost, "/api/loadpoints/2/vehicle/my%20car", "", false},
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

	handler, err := newHandler(target, false)
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
	handler, err := newHandler(target, false)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `id="display"`) {
		t.Fatalf("unexpected index response: %d", response.Code)
	}
}

func TestHandlerDisablesControlOnServer(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler, err := newHandler(target, true)
	if err != nil {
		t.Fatal(err)
	}

	configResponse := httptest.NewRecorder()
	handler.ServeHTTP(configResponse, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if configResponse.Code != http.StatusOK || !strings.Contains(configResponse.Body.String(), `"controlDisabled":true`) {
		t.Fatalf("unexpected server config response: %d %q", configResponse.Code, configResponse.Body.String())
	}

	controlResponse := httptest.NewRecorder()
	handler.ServeHTTP(controlResponse, httptest.NewRequest(http.MethodPost, "/api/loadpoints/1/mode/off", nil))
	if controlResponse.Code != http.StatusForbidden {
		t.Fatalf("control request status = %d, want %d", controlResponse.Code, http.StatusForbidden)
	}
	vehicleResponse := httptest.NewRecorder()
	handler.ServeHTTP(vehicleResponse, httptest.NewRequest(http.MethodPost, "/api/loadpoints/1/vehicle/my-car", nil))
	if vehicleResponse.Code != http.StatusForbidden {
		t.Fatalf("vehicle selection status = %d, want %d", vehicleResponse.Code, http.StatusForbidden)
	}
	if upstreamRequests != 0 {
		t.Fatalf("control request reached evcc %d times", upstreamRequests)
	}

	stateResponse := httptest.NewRecorder()
	handler.ServeHTTP(stateResponse, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	if stateResponse.Code != http.StatusOK || upstreamRequests != 1 {
		t.Fatalf("state API request was not proxied: status %d, upstream requests %d", stateResponse.Code, upstreamRequests)
	}
}

func TestHandlerAllowsControlByDefault(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests++
		if r.URL.Path != "/api/loadpoints/1/mode/off" {
			t.Errorf("unexpected upstream path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler, err := newHandler(target, false)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/loadpoints/1/mode/off", nil))
	if response.Code != http.StatusNoContent || upstreamRequests != 1 {
		t.Fatalf("control request was not proxied: status %d, upstream requests %d", response.Code, upstreamRequests)
	}
}

func TestHandlerProxiesVehicleSelection(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests++
		if r.URL.Path != "/api/loadpoints/2/vehicle/my-car" || r.Method != http.MethodPost {
			t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler, err := newHandler(target, false)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/loadpoints/2/vehicle/my-car", nil))
	if response.Code != http.StatusOK || upstreamRequests != 1 {
		t.Fatalf("vehicle selection was not proxied: status %d, upstream requests %d", response.Code, upstreamRequests)
	}
}
