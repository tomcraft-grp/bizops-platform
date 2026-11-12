// Fixed timezone so date-boundary tests are reproducible on any machine (Thailand, UTC+7, no DST)
export default function setup() {
  process.env.TZ = 'Asia/Bangkok';
}
