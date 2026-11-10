import { t } from "../../lib/i18n";
import { LogOut } from "lucide-react";
import type { User } from "../../lib/types";
import { Avatar, Card, Row, Sec } from "./ui";

/** The server exposes the signed-in profile read-only plus sign-out; credential and device management have no endpoint. */
export function AccountTab({ user, onLogout }: { user: User; onLogout: () => void }) {
  const role = t(user.role === "admin" ? "sidebar.role.admin" : "sidebar.role.user");
  return (
    <>
      <Sec index={0} title={t("settings.profile")}>
        <Card>
          <div className="st-prof">
            <Avatar user={user} large />
            <div className="st-prof-t">
              <b>{user.display_name || user.username}</b>
              <small>@{user.username}<span className="pill" data-tone="accent">{role}</span></small>
            </div>
          </div>
        </Card>
      </Sec>
      <Sec index={1} title={t("settings.sessionSection")}>
        <Card>
          <Row title={t("login.signOut")} desc={t("settings.signOutHint")}>
            <button type="button" className="btn secondary sm" onClick={onLogout}><LogOut size={14} />{t("login.signOut")}</button>
          </Row>
        </Card>
      </Sec>
    </>
  );
}
