import { t, useI18n } from "../lib/i18n";
import { ArrowUpRight } from "lucide-react";
import { memo, useState, type CSSProperties } from "react";
import type { SearchResult } from "../lib/processTimeline";

const hueOf = (host: string) => [...host].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);

/**
 * Site mark: a coloured letter tile (stable per host) with the site's own favicon laid over it once it loads.
 * Only the origin's public /favicon.ico is requested, with no credentials or referrer.
 */
export const Favicon = memo(function Favicon({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(true);
  const site = new URL(url);
  return (
    <span className="fav" style={{ "--fh": hueOf(site.hostname) } as CSSProperties} title={site.hostname} aria-hidden="true">
      {site.hostname.replace(/^www\./, "")[0]?.toUpperCase()}
      {loaded ? <img src={`${site.origin}/favicon.ico`} alt="" loading="lazy" crossOrigin="anonymous" referrerPolicy="no-referrer"
        onLoad={(event) => { if (!event.currentTarget.naturalWidth) setLoaded(false); }} onError={() => setLoaded(false)} /> : null}
    </span>
  );
});

export const SearchResults = memo(function SearchResults({ query, results, running }: { query: string; results: SearchResult[]; running: boolean }) {
  useI18n();
  return (
    <div className="tb-search">
      {query ? <div className="tb-q"><span>{query}</span>{running ? null : <small>{t("process.results", { count: results.length })}</small>}</div> : null}
      {results.length === 0 && !running ? <p className="tb-empty">{t("search.noResults")}</p> : results.map((result, index) => (
        <a className="sr" style={{ "--i": index } as CSSProperties} href={result.url} key={result.url} target="_blank" rel="noopener noreferrer">
          <Favicon url={result.url} />
          <span className="sr-main">
            <b>{result.title}</b>
            <small>{new URL(result.url).hostname}{result.published_at ? ` · ${result.published_at}` : ""}{result.description ? ` · ${result.description}` : ""}</small>
          </span>
          <ArrowUpRight className="go" size={13} aria-hidden="true" />
        </a>
      ))}
      {running ? Array.from({ length: Math.max(0, 3 - results.length) }, (_, index) => (
        <div className="sr skel" key={`skel${index}`} aria-hidden="true">
          <span className="skeleton skel-icon" />
          <span className="sr-main"><span className="skeleton skel-line" /><span className="skeleton skel-line sub" /></span>
        </div>
      )) : null}
    </div>
  );
});
