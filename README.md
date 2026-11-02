# SF SQLite Bridge

A desktop app for processing Salesforce data outside the org: pull it into SQLite, work on it in SQL or JavaScript, generate new data, and send it back in one click.

## Why you would use it

Use it when the data processing is best performed outside of Salesforce. Extract records into a local database, process them in SQL or JavaScript, and move the result back with a saved job you can run again in one click.

That is a practical way to create synthetic test data, including for performance testing, and to run transformations, cleansing, or any other processing locally. The same path is built for volume: the SQLite database can handle tens of millions of records, and parallel processing and Bulk API 2.0 can be used for large write-backs.

### Load and send data in a few clicks

Create an extraction job or a write-back job, then run it.

Extraction pulls a Salesforce object, or a full SOQL query, into a SQLite table. You choose the fields, add relationship fields such as `CreatedBy.Name`, and optionally set a filter, a row limit, and indexes. Each run can replace the table or append to it.

Write-back starts from a SQL query. You map columns to Salesforce fields and choose insert, update, upsert, delete, or undelete. Lookup fields can match on an External ID instead of a Salesforce record ID. Large loads can use Bulk API 2.0, and both directions support parallel processing. Once a job is saved, running it again is one click. Failed write-back rows can be retried without rebuilding the job.

### Shape and generate data in place

After the records are in tables, SQL is how you change them: joins, filters, calculated columns, and `CREATE TABLE AS SELECT` to generate a new dataset from the ones you already have. When a step needs logic SQL cannot express, the JavaScript runner works on the same database, row by row. Scripts can also call your saved extract and write-back jobs, so a full load, transform, and send-back sequence can live in one program.

### Ask an assistant that can see the data

The AI assistant reads the schema and can run SQL, explain the results, and draft JavaScript that writes its output back into tables. Use it to understand a dataset, build a query, or sketch a transformation. Statements that change data, and scripts that run, wait for your confirmation. Bring your own model: OpenAI, Anthropic, Mistral, a local Ollama instance, or a LiteLLM proxy.

### Share the workspace as one SQLite file

The database file holds the records and the work around them: extraction and write-back jobs, saved SQL queries, and JavaScript programs. Copy the file and the next person opens the same tables, jobs, and scripts. There is no project folder to assemble and no server to deploy. The app runs on macOS, Windows, and Linux, and connects with OAuth or an org you have already logged into with the Salesforce CLI.

A few things that make the daily work easier:

- The query editor runs SQLite and SOQL in the same place, with saved tabs and a schema browser you can drag fields from.
- Each job keeps a run history with record counts and errors. Write-back progress can be filtered by status or by error.
- CSV import and export are still there when a file is the format you need.

---

## Features

### Connections

- Open an existing **SQLite database** or create a new one.
- Connect to Salesforce using **OAuth 2.0** (Connected App) or the **Salesforce CLI** (if you have `sf` installed and orgs already authenticated).
- The app remembers recently opened databases for quick access.

---

### Jobs (Extract & Write-back)

Extract and write-back jobs are managed together in a single **Jobs** window. The job list shows both types side by side, sorted by Salesforce object name, with a distinct icon (⬇ for extract, ⬆ for write-back).

#### SF → SQLite (Extract Jobs)

Download data from Salesforce into your local SQLite database.

- Pick any Salesforce object, or write a **full SOQL query** to extract exactly what you need.
- Select the fields you want to download.
- Add custom **SOQL SELECT expressions** (e.g., relationship fields such as `CreatedBy.Name`, stored as `CreatedBy_Name` in SQLite).
- Set an optional **WHERE clause** and **LIMIT**.
- Choose the **write mode**: replace the table contents, or append to it.
- Optionally create **indexes** on extracted columns.
- Run multiple extract jobs **in parallel**.
- View the run history for each job, including record counts and any errors.

#### SQLite → SF (Write-back Jobs)

Push data from your local SQLite database back to Salesforce.

- Write a SQL query that selects the rows to send.
- Map SQLite columns to Salesforce fields.
- Choose the **operation**: Insert, Update, Upsert, Delete, or Undelete.
- Use the standard **REST API** or the **Bulk API 2.0** for large volumes.
- Map lookup fields via an **External ID** field instead of the internal Salesforce record ID.
- Configure batch size and parallelism.
- Monitor progress row by row in real time; filter by status (OK / Error / Queued) and by error type.
- Retry failed records with a single click.

---

### Query Editor

Write and execute queries directly against your data.

- Full-featured **SQL editor** with syntax highlighting, autocomplete for table and column names, and keyboard shortcuts.
- Switch between **Execute SQLite** and **Execute SOQL** modes with a single toggle — the same editor runs SQL queries against your local database or SOQL queries against Salesforce.
- If you place the cursor inside a statement (with no selection), only that statement is executed. Select text to run just the selection.
- Results are displayed in a data grid.
- **Export results to CSV** with a single click.
- Save and name queries as tabs; tabs are preserved across restarts.
- Browse **SQLite tables** and **Salesforce objects** in the schema panel. Drag a table or field name into the editor to insert it.

---

### Database Explorer

Browse and manage your SQLite database.

- See all tables and views with row counts.
- Inspect **columns** (name, type, nullability, default, primary key) and **indexes**.
- **Preview** the first 100 rows of any table.
- Open a table directly in the Query Editor.
- Rename or delete tables and columns.
- **Export** any table to a CSV file.
- **Import CSV files**: drag a CSV onto the import zone (or click to browse), preview the first rows, set a target table name, and import — the table is created automatically from the CSV headers.

---

### JavaScript Script Runner

Execute JavaScript code directly against your open database, and orchestrate full data-movement pipelines.

- Write scripts using a built-in `db` API to run queries, iterate rows, and build automation logic.
- **Orchestrate extract and write-back jobs** from a script using the `jobs` API: `jobs.runDownload(name)` and `jobs.runWriteback(name)` trigger saved jobs and return promises, so you can sequence or parallelise them with `await` and `Promise.all()`. Scripts respect the same five-slot concurrency queue as the UI.
- Inspect write-back outcomes: `jobs.getFailedRows(result)` lazily fetches failed row details — all from within the script.
- Full-featured **JavaScript editor** with syntax highlighting.
- View log output and results in real time.
- Save and manage named scripts.

---

### AI Assistant

An LLM-powered assistant that understands your database schema and can query and modify it on your behalf.

- Ask questions in plain English — the assistant runs SQL queries and interprets the results for you.
- Supports **OpenAI**, **Anthropic**, **Mistral**, **Ollama** (local), and **LiteLLM** (proxy).
- Can execute DDL/DML statements (CREATE, INSERT, UPDATE, …) with your explicit confirmation before each change.
- Can execute Javascript with your explicit confirmation.
- Conversation history is preserved per database session.
- Customize the system prompt template from the Settings view.

---

## Requirements

- Built with **Electron** — runs on macOS, Windows, and Linux.
- A Salesforce org (Developer Edition, Sandbox, or Production).
- For CLI authentication: [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installed and at least one org logged in.
- For OAuth authentication: a Salesforce Connected App with `api` and `refresh_token` scopes.

## Getting Started (development)

```bash
npm install
npm run dev        # start in development mode (hot reload)
npm run build      # build for production
npm run dist:mac   # package for macOS
npm run dist:win   # package for Windows
npm run dist:linux # package for Linux
```

