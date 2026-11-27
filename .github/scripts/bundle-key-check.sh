# Run by deploy.yml through `eas env:exec preview`, so EXPO_PUBLIC_SUPABASE_KEY is the preview environment's
# value; it's never printed. POSIX sh: env:exec runs it with /bin/sh, which is dash on the runners.
case "$EXPO_PUBLIC_SUPABASE_KEY" in
  sb_publishable_*) ;;
  *) echo "EXPO_PUBLIC_SUPABASE_KEY in EAS's preview environment is missing or isn't a publishable key"; exit 1 ;;
esac
for p in android ios; do
  grep -raqF "$EXPO_PUBLIC_SUPABASE_KEY" "dist/_expo/static/js/$p" || { echo "the $p bundle lacks the publishable key"; exit 1; }
done
