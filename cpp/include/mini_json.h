#pragma once
//
// Tiny JSON reader for the directory's responses (objects, arrays, strings, numbers,
// true/false/null). Not a general-purpose parser: no \u escapes beyond the BMP basics,
// no streaming, depth-limited.

#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

namespace sdi::json {

struct Value {
    enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
    bool        b = false;
    double      n = 0;
    std::string s;
    std::vector<Value>                         a;
    std::vector<std::pair<std::string, Value>> o;

    const Value* get(const std::string& k) const {
        for (const auto& kv : o) if (kv.first == k) return &kv.second;
        return nullptr;
    }
    std::string str(const std::string& k, const std::string& def = "") const {
        const Value* v = get(k);
        return v && v->type == Str ? v->s : def;
    }
    double num(const std::string& k, double def = 0) const {
        const Value* v = get(k);
        return v && v->type == Num ? v->n : def;
    }
};

namespace detail {

struct Parser {
    const std::string& t;
    size_t i = 0;
    explicit Parser(const std::string& text) : t(text) {}

    void ws() { while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) ++i; }
    bool lit(const char* w) {
        size_t n = 0; while (w[n]) ++n;
        if (t.compare(i, n, w) != 0) return false;
        i += n; return true;
    }

    bool string(std::string& out) {
        if (i >= t.size() || t[i] != '"') return false;
        ++i;
        while (i < t.size() && t[i] != '"') {
            char c = t[i++];
            if (c == '\\') {
                if (i >= t.size()) return false;
                const char e = t[i++];
                switch (e) {
                    case 'n': out += '\n'; break;  case 't': out += '\t'; break;
                    case 'r': out += '\r'; break;  case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'u': {
                        if (i + 4 > t.size()) return false;
                        const unsigned cp = unsigned(std::strtoul(t.substr(i, 4).c_str(), nullptr, 16));
                        i += 4;
                        if (cp < 0x80) out += char(cp);
                        else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
                        else { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
                        break;
                    }
                    default: out += e; break;   // " \ /
                }
            } else out += c;
        }
        if (i >= t.size()) return false;
        ++i;
        return true;
    }

    bool value(Value& v, int depth) {
        if (depth > 16) return false;
        ws();
        if (i >= t.size()) return false;
        const char c = t[i];
        if (c == '{') {
            ++i; v.type = Value::Obj; ws();
            if (i < t.size() && t[i] == '}') { ++i; return true; }
            for (;;) {
                ws();
                std::string k;
                if (!string(k)) return false;
                ws();
                if (i >= t.size() || t[i++] != ':') return false;
                Value child;
                if (!value(child, depth + 1)) return false;
                v.o.emplace_back(std::move(k), std::move(child));
                ws();
                if (i >= t.size()) return false;
                if (t[i] == ',') { ++i; continue; }
                if (t[i] == '}') { ++i; return true; }
                return false;
            }
        }
        if (c == '[') {
            ++i; v.type = Value::Arr; ws();
            if (i < t.size() && t[i] == ']') { ++i; return true; }
            for (;;) {
                Value child;
                if (!value(child, depth + 1)) return false;
                v.a.push_back(std::move(child));
                ws();
                if (i >= t.size()) return false;
                if (t[i] == ',') { ++i; continue; }
                if (t[i] == ']') { ++i; return true; }
                return false;
            }
        }
        if (c == '"') { v.type = Value::Str; return string(v.s); }
        if (lit("true"))  { v.type = Value::Bool; v.b = true;  return true; }
        if (lit("false")) { v.type = Value::Bool; v.b = false; return true; }
        if (lit("null"))  { v.type = Value::Null; return true; }
        char* end = nullptr;
        const double d = std::strtod(t.c_str() + i, &end);
        if (end == t.c_str() + i) return false;
        i = size_t(end - t.c_str());
        v.type = Value::Num; v.n = d;
        return true;
    }
};

} // namespace detail

// True on success; trailing garbage is an error.
inline bool parse(const std::string& text, Value& out) {
    detail::Parser p(text);
    out = Value{};
    if (!p.value(out, 0)) return false;
    p.ws();
    return p.i == text.size();
}

} // namespace sdi::json
