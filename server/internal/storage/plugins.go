package storage

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrPluginLocked    = errors.New("this plugin is enabled by the administrator and cannot be disabled")
	ErrPluginConflict  = errors.New("a plugin or component with this ID already exists")
	pluginIDPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	componentIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
)

type Plugin struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	Enabled        bool      `json:"enabled"`
	DefaultEnabled bool      `json:"default_enabled"`
	SkillIDs       []string  `json:"skill_ids"`
	MCPIDs         []string  `json:"mcp_ids"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type UserPlugin struct {
	Plugin
	EffectiveEnabled bool `json:"effective_enabled"`
	Locked           bool `json:"locked"`
}

func ValidatePlugin(p Plugin) error {
	if !pluginIDPattern.MatchString(p.ID) {
		return errors.New("plugin ID must be a lowercase slug of 1-64 letters, digits, hyphens or underscores")
	}
	if strings.TrimSpace(p.Name) == "" || utf8.RuneCountInString(p.Name) > 100 {
		return errors.New("plugin name must contain 1-100 characters")
	}
	if len(p.Description) > 4000 {
		return errors.New("plugin description must not exceed 4000 bytes")
	}
	if count := len(p.SkillIDs) + len(p.MCPIDs); count < 1 || count > 64 {
		return errors.New("a plugin must contain 1-64 components")
	}
	for _, ids := range [][]string{p.SkillIDs, p.MCPIDs} {
		seen := map[string]bool{}
		for _, id := range ids {
			if !componentIDPattern.MatchString(id) || seen[id] {
				return errors.New("plugin component IDs must be unique IDs of 1-64 letters, digits, hyphens or underscores")
			}
			seen[id] = true
		}
	}
	return nil
}

const pluginColumns = `p.id,p.name,p.description,p.enabled,p.default_enabled,
	ARRAY(SELECT component_id FROM plugin_components c WHERE c.plugin_id=p.id AND kind='skills' ORDER BY component_id),
	ARRAY(SELECT component_id FROM plugin_components c WHERE c.plugin_id=p.id AND kind='mcp' ORDER BY component_id),
	p.created_at,p.updated_at`

func scanPlugin(row pgx.Row, p *Plugin) error {
	return row.Scan(&p.ID, &p.Name, &p.Description, &p.Enabled, &p.DefaultEnabled, &p.SkillIDs, &p.MCPIDs, &p.CreatedAt, &p.UpdatedAt)
}

// Every catalog write and preference change shares one transaction lock. Ownership and
// mandatory-enable checks therefore cannot race each other in separate requests.
func lockPluginCatalog(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext(current_schema()),1868786025)`)
	return err
}

func pluginConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrPluginConflict
	}
	return err
}

func writePluginComponents(ctx context.Context, tx pgx.Tx, p Plugin) error {
	for kind, ids := range map[string][]string{"skills": p.SkillIDs, "mcp": p.MCPIDs} {
		for _, id := range ids {
			if _, err := tx.Exec(ctx, `INSERT INTO plugin_components(plugin_id,kind,component_id) VALUES($1,$2,$3)`, p.ID, kind, id); err != nil {
				return pluginConflict(err)
			}
		}
	}
	return nil
}

func (s *Store) ListPlugins(ctx context.Context) ([]Plugin, error) {
	rows, err := s.db.Query(ctx, `SELECT `+pluginColumns+` FROM plugins p ORDER BY lower(p.name),p.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []Plugin{}
	for rows.Next() {
		var p Plugin
		if err := scanPlugin(rows, &p); err != nil {
			return nil, err
		}
		values = append(values, p)
	}
	return values, rows.Err()
}

func (s *Store) GetPlugin(ctx context.Context, id string) (Plugin, error) {
	var p Plugin
	err := scanPlugin(s.db.QueryRow(ctx, `SELECT `+pluginColumns+` FROM plugins p WHERE p.id=$1`, id), &p)
	return p, err
}

func (s *Store) SavePlugin(ctx context.Context, p Plugin, create bool) (Plugin, error) {
	p.Name, p.Description = strings.TrimSpace(p.Name), strings.TrimSpace(p.Description)
	if err := ValidatePlugin(p); err != nil {
		return Plugin{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Plugin{}, err
	}
	defer tx.Rollback(context.Background())
	if err = lockPluginCatalog(ctx, tx); err != nil {
		return Plugin{}, err
	}
	if create {
		_, err = tx.Exec(ctx, `INSERT INTO plugins(id,name,description,enabled,default_enabled) VALUES($1,$2,$3,$4,$5)`, p.ID, p.Name, p.Description, p.Enabled, p.DefaultEnabled)
	} else {
		var tag pgconn.CommandTag
		tag, err = tx.Exec(ctx, `UPDATE plugins SET name=$2,description=$3,enabled=$4,default_enabled=$5,updated_at=now() WHERE id=$1`, p.ID, p.Name, p.Description, p.Enabled, p.DefaultEnabled)
		if err == nil && tag.RowsAffected() == 0 {
			return Plugin{}, pgx.ErrNoRows
		}
		if err == nil {
			_, err = tx.Exec(ctx, `DELETE FROM plugin_components WHERE plugin_id=$1`, p.ID)
		}
	}
	if err != nil {
		return Plugin{}, pluginConflict(err)
	}
	if err = writePluginComponents(ctx, tx, p); err != nil {
		return Plugin{}, err
	}
	if err = scanPlugin(tx.QueryRow(ctx, `SELECT `+pluginColumns+` FROM plugins p WHERE p.id=$1`, p.ID), &p); err != nil {
		return Plugin{}, err
	}
	return p, tx.Commit(ctx)
}

func (s *Store) DeletePlugin(ctx context.Context, id string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = lockPluginCatalog(ctx, tx); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM plugins WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

func (s *Store) UserPlugins(ctx context.Context, userID string) ([]UserPlugin, error) {
	rows, err := s.db.Query(ctx, `SELECT `+pluginColumns+`,(p.default_enabled OR COALESCE(u.enabled,false)) FROM plugins p
		LEFT JOIN user_plugins u ON u.plugin_id=p.id AND u.user_id=$1 WHERE p.enabled ORDER BY lower(p.name),p.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []UserPlugin{}
	for rows.Next() {
		var p UserPlugin
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.Enabled, &p.DefaultEnabled, &p.SkillIDs, &p.MCPIDs, &p.CreatedAt, &p.UpdatedAt, &p.EffectiveEnabled); err != nil {
			return nil, err
		}
		p.Locked = p.DefaultEnabled
		values = append(values, p)
	}
	return values, rows.Err()
}

func (s *Store) SetUserPlugin(ctx context.Context, userID, id string, enabled bool) (UserPlugin, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return UserPlugin{}, err
	}
	defer tx.Rollback(context.Background())
	if err = lockPluginCatalog(ctx, tx); err != nil {
		return UserPlugin{}, err
	}
	var p UserPlugin
	if err = scanPlugin(tx.QueryRow(ctx, `SELECT `+pluginColumns+` FROM plugins p WHERE p.id=$1 AND p.enabled`, id), &p.Plugin); err != nil {
		return UserPlugin{}, err
	}
	if p.DefaultEnabled && !enabled {
		return UserPlugin{}, ErrPluginLocked
	}
	_, err = tx.Exec(ctx, `INSERT INTO user_plugins(user_id,plugin_id,enabled) VALUES($1,$2,$3)
		ON CONFLICT(user_id,plugin_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`, userID, id, enabled)
	if err != nil {
		return UserPlugin{}, err
	}
	p.EffectiveEnabled, p.Locked = enabled || p.DefaultEnabled, p.DefaultEnabled
	return p, tx.Commit(ctx)
}

// Only component IDs leave storage; MCP environment values and skill bodies
// remain in the administrator-controlled workspace configuration.
func (s *Store) EffectivePluginComponents(ctx context.Context, userID string) (skills, mcp []string, err error) {
	skills, mcp = []string{}, []string{}
	rows, err := s.db.Query(ctx, `SELECT c.kind,c.component_id FROM plugin_components c JOIN plugins p ON p.id=c.plugin_id
		LEFT JOIN user_plugins u ON u.plugin_id=p.id AND u.user_id=$1
		WHERE p.enabled AND (p.default_enabled OR COALESCE(u.enabled,false)) ORDER BY c.kind,c.component_id`, userID)
	if err != nil {
		return skills, mcp, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, id string
		if err := rows.Scan(&kind, &id); err != nil {
			return skills, mcp, err
		}
		if kind == "skills" {
			skills = append(skills, id)
		} else {
			mcp = append(mcp, id)
		}
	}
	return skills, mcp, rows.Err()
}

func (s *Store) PluginForComponent(ctx context.Context, kind, id string) (string, error) {
	var pluginID string
	err := s.db.QueryRow(ctx, `SELECT plugin_id FROM plugin_components WHERE kind=$1 AND component_id=$2`, kind, id).Scan(&pluginID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return pluginID, err
}
