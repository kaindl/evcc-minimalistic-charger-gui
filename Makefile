APP := evcc-minimalistic-charger-gui
GO ?= go
PREFIX ?= /usr
BINDIR ?= $(PREFIX)/bin
UNITDIR ?= $(PREFIX)/lib/systemd/system
SYSCONFDIR ?= /etc
BUILD_DIR ?= build
VERSION ?= 0.1.0
ARCH ?= $(shell dpkg --print-architecture)

PACKAGE_ROOT := $(BUILD_DIR)/debian
DEB_FILE := $(BUILD_DIR)/$(APP)_$(VERSION)_$(ARCH).deb

.PHONY: all build install deb clean

all: build

build:
	mkdir -p "$(BUILD_DIR)"
	CGO_ENABLED=0 GOOS=linux $(GO) build -trimpath -ldflags="-s -w" -o "$(BUILD_DIR)/$(APP)" .

install: build
	install -D -m 0755 "$(BUILD_DIR)/$(APP)" "$(DESTDIR)$(BINDIR)/$(APP)"
	install -D -m 0644 packaging/$(APP).service "$(DESTDIR)$(UNITDIR)/$(APP).service"
	@if [ ! -e "$(DESTDIR)$(SYSCONFDIR)/default/$(APP).env" ]; then \
		install -D -m 0644 packaging/$(APP).env "$(DESTDIR)$(SYSCONFDIR)/default/$(APP).env"; \
	fi

deb: build
	rm -rf "$(PACKAGE_ROOT)"
	install -D -m 0755 "$(BUILD_DIR)/$(APP)" "$(PACKAGE_ROOT)/usr/bin/$(APP)"
	install -D -m 0644 packaging/$(APP).service "$(PACKAGE_ROOT)/usr/lib/systemd/system/$(APP).service"
	install -D -m 0644 packaging/$(APP).env "$(PACKAGE_ROOT)/etc/default/$(APP).env"
	install -D -m 0644 LICENSE "$(PACKAGE_ROOT)/usr/share/doc/$(APP)/copyright"
	install -D -m 0644 README.md "$(PACKAGE_ROOT)/usr/share/doc/$(APP)/README.md"
	install -D -m 0644 screenshots/charging-point.png "$(PACKAGE_ROOT)/usr/share/doc/$(APP)/screenshots/charging-point.png"
	install -D -m 0644 screenshots/house-energy-flow.png "$(PACKAGE_ROOT)/usr/share/doc/$(APP)/screenshots/house-energy-flow.png"
	mkdir -p "$(PACKAGE_ROOT)/DEBIAN"
	printf 'Package: %s\nVersion: %s\nSection: web\nPriority: optional\nArchitecture: %s\nMaintainer: Markus Kaindl\nDescription: Responsive web display for evcc charging points\n A lightweight web interface and API proxy for evcc.\n' \
		"$(APP)" "$(VERSION)" "$(ARCH)" > "$(PACKAGE_ROOT)/DEBIAN/control"
	printf '/etc/default/%s.env\n' "$(APP)" > "$(PACKAGE_ROOT)/DEBIAN/conffiles"
	dpkg-deb --build --root-owner-group "$(PACKAGE_ROOT)" "$(DEB_FILE)"

clean:
	rm -f "$(BUILD_DIR)/$(APP)"
	rm -rf "$(PACKAGE_ROOT)"
	rm -f "$(DEB_FILE)"
