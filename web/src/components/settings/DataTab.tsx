import { t } from "../../lib/i18n";
import { useState } from "react";
import { Download, RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { applyDisplay, setCanvas, setDensity, setLook, setReduceMotion, setTextSize, setThemePref } from "../../lib/appearance";
import { toast } from "../ui/Toast";
import { Card, ErrorAlert, Row, Sec, useSaved } from "./ui";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Only actions that exist: export the account's memories, and reset this browser's appearance. */
export function DataTab() {
  const { saved } = useSaved();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  async function exportMemories() {
    setExporting(true);
    setError("");
    try {
      const memories = await api.memories();
      download("ochi-memories.json", JSON.stringify(memories ?? [], null, 2), "application/json;charset=utf-8");
      saved("export");
      toast(t("settings.exportDone"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("error.save"));
    } finally {
      setExporting(false);
    }
  }
  function resetAppearance() {
    setThemePref("light");
    setLook("quiet");
    setCanvas("paper");
    setTextSize(100);
    setDensity("cozy");
    setReduceMotion(false);
    applyDisplay();
    saved("reset");
    toast(t("settings.resetDone"));
  }
  return (
    <>
      {error && <ErrorAlert message={error} />}
      <Sec index={0} title={t("settings.sec.yourData")}>
        <Card>
          <Row id="export" title={t("settings.exportMemories")} desc={t("settings.exportMemoriesHint")}>
            <button type="button" className={`btn secondary sm${exporting ? " btn-progress" : ""}`} disabled={exporting} onClick={() => void exportMemories()}>
              <Download size={14} />{exporting ? t("settings.exporting") : t("settings.exportAction")}
            </button>
          </Row>
        </Card>
      </Sec>
      <Sec index={1} title={t("settings.sec.device")} note={t("settings.dataNote")}>
        <Card>
          <Row id="reset" title={t("settings.resetAppearance")} desc={t("settings.resetAppearanceHint")}>
            <button type="button" className="btn secondary sm" onClick={resetAppearance}><RotateCcw size={14} />{t("settings.resetAction")}</button>
          </Row>
        </Card>
      </Sec>
    </>
  );
}
