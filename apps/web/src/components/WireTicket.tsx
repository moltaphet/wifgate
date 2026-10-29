/** The hero: one request/response exchange as it appears on the wire. Pure CSS animation, no JS. */
export function WireTicket() {
  let i = 0;
  const n = () => i++;
  return (
    <figure className="ticket" aria-label="Example of the HTTP 402 exchange">
      <figcaption className="ticket__head">
        <span>one call, on the wire</span>
        <span>wifgate-v1</span>
      </figcaption>
      <ol className="wire">
        <li className="wire__line" style={{ ["--i" as string]: n() }}>
          <span className="wire__arrow">→</span>
          <span className="wire__text">GET /api/wif-stats</span>
        </li>
        <li className="wire__line" style={{ ["--i" as string]: n() }}>
          <span className="wire__arrow">←</span>
          <span className="wire__text">
            <span className="wire__status wire__status--402" style={{ ["--i" as string]: i - 1 }}>402</span> Payment Required
            <br />
            <span className="wire__dim">price </span><span className="wire__money">1 WIF</span>
            <span className="wire__dim"> · payTo 0x9a3…e1f · nonce 0x51c…7d</span>
          </span>
        </li>
        <li className="wire__gap" aria-hidden />
        <li className="wire__line" style={{ ["--i" as string]: n() }}>
          <span className="wire__arrow">⛓</span>
          <span className="wire__text">
            WifGate.pay(seller, route, nonce, 1 WIF)
            <br />
            <span className="wire__dim">0.98 → seller · </span><span className="wire__money">0.02 → burned</span>
          </span>
        </li>
        <li className="wire__gap" aria-hidden />
        <li className="wire__line" style={{ ["--i" as string]: n() }}>
          <span className="wire__arrow">→</span>
          <span className="wire__text">
            GET /api/wif-stats
            <br />
            <span className="wire__dim">x-wif-proof: tx 0xd4e…a90 + wallet signature</span>
          </span>
        </li>
        <li className="wire__line" style={{ ["--i" as string]: n() }}>
          <span className="wire__arrow">←</span>
          <span className="wire__text">
            <span className="wire__ok">200 OK</span> <span className="wire__dim">{`{ "totalBurned": "…" }`}</span>
          </span>
        </li>
      </ol>
      <div className="ticket__foot">
        <span>illustrative values</span>
        <span>burned this call <strong>0.02 WIF</strong></span>
      </div>
    </figure>
  );
}
