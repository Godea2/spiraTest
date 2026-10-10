// Writes a small demo scope workbook to tests/fixtures/sample-scope.xlsx.
import * as fs from "node:fs";
import * as XLSX from "xlsx";

XLSX.set_fs(fs);

const header = ["TC ID", "Test Scenario", "Module", "Priority", "Owner"];
const inScope = [
  ["Release scope — Phase 1"],
  ["Generated sample for local testing"],
  header,
  ...Array.from({ length: 40 }, (_, i) => [`ONB-${String(i + 1).padStart(3, "0")}`, `Onboarding scenario ${i + 1}`, "Onboarding", i % 3 ? "Medium" : "High", "QA"]),
  [],
  ...Array.from({ length: 12 }, (_, i) => [`ACC-${String(i + 1).padStart(3, "0")}`, `Accounts scenario ${i + 1}`, "Accounts", "Low", "QA"]),
];
const needsConfirmation = [
  header,
  ["ONB-090", "Onboarding scenario awaiting sign-off", "onboarding ", "Medium", "PO"],
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inScope), "Phase 1 In-Scope");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(needsConfirmation), "Needs Confirmation");
fs.mkdirSync("tests/fixtures", { recursive: true });
XLSX.writeFile(wb, "tests/fixtures/sample-scope.xlsx");
console.log("Wrote tests/fixtures/sample-scope.xlsx");
