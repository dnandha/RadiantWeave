.PHONY: help backend-install backend-run frontend-install frontend-run dev

PYTHON ?= python
UVICORN ?= uvicorn
BACKEND_APP ?= backend.api.routes:app

help:
	@echo "Available targets:"
	@echo "  backend-install  Install Python dependencies"
	@echo "  backend-run      Run FastAPI backend with uvicorn"
	@echo "  frontend-install Install frontend npm dependencies"
	@echo "  frontend-run     Run frontend dev server (Vite)"
	@echo "  dev              Run backend and frontend together (frontend in foreground)"

backend-install:
	$(PYTHON) -m pip install -r requirements.txt

backend-run:
	$(UVICORN) $(BACKEND_APP) --reload

frontend-install:
	cd frontend && npm install

frontend-run:
	cd frontend && npm run dev

dev:
	$(UVICORN) $(BACKEND_APP) --reload &
	cd frontend && npm run dev

