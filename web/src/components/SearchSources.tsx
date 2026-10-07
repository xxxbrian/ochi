import { Globe2 } from "lucide-react";
import { memo, useState } from "react";
import type { SearchResult } from "../lib/processTimeline";
import "./process-timeline.css";

const SiteIcon = memo(function SiteIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const site = new URL(url);
  return (
    <span className="search-site-icon" title={site.hostname} aria-hidden="true">
      {failed ? <Globe2 size={12} /> : (
        <img
          src={`${site.origin}/favicon.ico`}
          alt=""
          loading="lazy"
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
});

export const SearchSiteIcons = memo(function SearchSiteIcons({ results }: { results: SearchResult[] }) {
  const sites = [...new Map(results.map((result) => [new URL(result.url).hostname, result.url])).values()].slice(0, 4);
  return <span className="search-site-icons">{sites.map((url) => <SiteIcon key={new URL(url).origin} url={url} />)}</span>;
});

export const SearchResults = memo(function SearchResults({ results }: { results: SearchResult[] }) {
  return (
    <div className="search-results">
      {results.length === 0 ? <p className="search-empty">没有找到相关结果</p> : results.map((result) => (
        <a className="search-result" href={result.url} key={result.url} target="_blank" rel="noopener noreferrer">
          <SiteIcon url={result.url} />
          <span>
            <strong>{result.title}</strong>
            <small>{new URL(result.url).hostname}{result.published_at ? ` · ${result.published_at}` : ""}</small>
            {result.description ? <p>{result.description}</p> : null}
          </span>
        </a>
      ))}
    </div>
  );
});
