# Internship Sankey Flow

Auto-updating Sankey diagram that visualizes internship application journeys, pulling live data from Notion.

## Setup

### 1. Create a Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration**
3. Name it (e.g. "Sankey Bot"), select your workspace
4. Copy the **Internal Integration Secret** (starts with `ntn_...`)

### 2. Share Notion databases with the integration

1. Open your **Internship** page in Notion
2. Click **⋯** → **Connections** → **Connect to** → select your integration
3. This gives the integration access to both Hang's and Tong's trackers

### 3. Add the secret to GitHub

1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `NOTION_TOKEN`
4. Value: paste the integration secret from step 1

### 4. Push these files to your repo

```
your-repo/
├── .github/workflows/update-sankey.yml
├── generate.mjs
├── internship_sankey_flow.html  (auto-generated)
└── README.md
```

### 5. Run it

- **Automatic**: Runs every 6 hours via GitHub Actions
- **Manual**: Go to repo → **Actions** → **Update Sankey** → **Run workflow**
- **After push**: The first run generates the HTML automatically

## How it works

1. `generate.mjs` uses the Notion API to query both internship tracker databases
2. It processes each application's company, status, and applied date
3. Groups applications into time-step columns and tracks status transitions
4. Generates a static HTML file with D3.js Sankey visualization
5. GitHub Actions commits the updated HTML back to the repo
6. GitHub Pages serves the HTML at your site URL
