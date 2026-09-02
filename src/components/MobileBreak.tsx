/** 携帯の版面(620px以下)のときだけ効く強制改行。パソコンでは何も起きない。 */
export default function MobileBreak() {
  return <br className="mobile-break" />;
}
