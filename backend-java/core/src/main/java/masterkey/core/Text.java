// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Text people write (API.md, Conventions, Text): without controls and what turns or hides text
 * on screen (bidi overrides, zero-width spaces; the emoji joiner U+200D stays), lengths in
 * characters (code points: {@code "😀".length()} is 2), spaces as Python's {@code str.strip}.
 * Compared with the Python on every Unicode character (JAVA-BACKEND.md §16).
 */
public final class Text {

    static final Pattern HIDDEN = Pattern.compile(
            "[\\x{0}-\\x{8}\\x{b}\\x{c}\\x{e}-\\x{1f}\\x{7f}-\\x{9f}\\x{200b}\\x{200e}\\x{200f}\\x{202a}-\\x{202e}\\x{2060}\\x{2066}-\\x{2069}\\x{feff}]");

    private Text() {
    }

    public static String plain(String s) {
        return HIDDEN.matcher(s).replaceAll("");
    }

    public static int length(String s) {
        return s.codePointCount(0, s.length());
    }

    public static String cut(String s, int max) {
        return length(s) <= max ? s : s.substring(0, s.offsetByCodePoints(0, max));
    }

    static boolean space(int c) {
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == 0x85;
    }

    /** As {@code str.strip()} in Python. */
    public static String strip(String s) {
        int a = 0;
        int b = s.length();
        while (a < b && space(s.codePointAt(a))) a += Character.charCount(s.codePointAt(a));
        while (b > a && space(s.codePointBefore(b))) b -= Character.charCount(s.codePointBefore(b));
        return s.substring(a, b);
    }

    /** As {@code " ".join(s.split())} in Python: runs of spaces become one, none at the ends. */
    public static String words(String s) {
        StringBuilder out = new StringBuilder();
        boolean gap = false;
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            if (space(c)) {
                gap = out.length() > 0;
            } else {
                if (gap) out.append(' ');
                gap = false;
                out.appendCodePoint(c);
            }
        }
        return out.toString();
    }

    /** Plain and stripped: what is stored of a field people write. */
    public static String clean(String s) {
        return strip(plain(s));
    }

    /**
     * A handle the rules allow, from a name or a username ({@code auth._handle_from}): ASCII
     * letters, digits, dots and underscores, accents off ("Müller" → "muller"), 3–30, no dot or
     * underscore at the ends; "" when nothing valid is left ("Алиса").
     */
    public static String handle(String text) {
        String plain = Normalizer.normalize(text, Normalizer.Form.NFKD)
                .replaceAll("[^\\x00-\\x7f]", "").toLowerCase(Locale.ROOT);
        StringBuilder kept = new StringBuilder();
        plain.chars().filter(x -> (x >= 'a' && x <= 'z') || (x >= '0' && x <= '9') || x == '.' || x == '_')
                .forEach(kept::appendCodePoint);
        String s = kept.toString().replaceAll("\\.{2,}", ".");
        if (s.length() > 30) s = s.substring(0, 30);
        s = s.replaceAll("^[._]+", "").replaceAll("[._]+$", "");
        return s.length() >= 3 ? s : "";
    }

    static final Pattern USERNAME = Pattern.compile("[a-z0-9._]{3,30}");

    /** A valid @handle as typed by a person (API.md, UserSummary): "" if fine, else why not. */
    public static String usernameProblem(String value) {
        if (value.length() > 30 || !USERNAME.matcher(value).matches()) return "3-30 of a-z 0-9 . _";
        if (value.startsWith(".") || value.endsWith(".")) return "no dot at the start or the end";
        if (value.contains("..")) return "no two dots in a row";
        return "";
    }
}
