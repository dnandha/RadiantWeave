# RadiantWeave – Underfloor Heating Designer

This project computes required **underfloor heating circuits** for a two‑storey building and generates **optimised pipe layouts** over a floorplan, following EN 1264‑style practice.

## Structure

- `backend/`: Python FastAPI service
  - `models/`: floorplan, zones, circuits data models
  - `en1264/`: simplified EN 1264 thermal and circuit sizing logic
  - `routing/`: geometric utilities and routing/path planning
  - `api/`: HTTP endpoints
- `frontend/`: React UI for uploading plans, drawing zones, and visualising circuits

Install Python dependencies:

```bash
pip install -r requirements.txt
```

Start the backend (example, once app is wired):

```bash
uvicorn backend.api.routes:app --reload
```

Frontend will be a separate React app (e.g. Vite) under `frontend/`.

## License

This project is licensed under the **Mozilla Public License 2.0** (MPL 2.0). See [LICENSE](LICENSE) for the full text. In short: you may use, modify, and distribute the code, but you must keep the license and copyright notices, and any modified or derivative source code you distribute must be released under the same license (open source).

