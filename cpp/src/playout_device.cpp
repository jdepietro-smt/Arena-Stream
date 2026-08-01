// Backend selector — returns the right concrete PlayoutDevice based on
// which backends were compiled in. Mirrors capture_device.cpp.

#include "playout_device.h"

#ifdef SDI_WITH_DECKLINK
#include "decklink_playout.h"
#endif

#ifdef SDI_WITH_AJA
#include "aja_playout.h"
#endif

namespace sdi {

std::unique_ptr<PlayoutDevice> make_playout(std::string_view kind) {
#ifdef SDI_WITH_DECKLINK
    if (kind == "decklink") return std::make_unique<DeckLinkPlayoutDevice>();
#endif
#ifdef SDI_WITH_AJA
    if (kind == "aja") return std::make_unique<AJAPlayoutDevice>();
#endif
    return nullptr;
}

} // namespace sdi
