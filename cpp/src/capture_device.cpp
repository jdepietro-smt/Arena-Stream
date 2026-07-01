// Backend selector — returns the right concrete CaptureDevice based on
// which backends were compiled in.

#include "capture_device.h"

#ifdef SDI_WITH_DECKLINK
#include "decklink_device.h"
#endif

#ifdef SDI_WITH_AJA
#include "aja_device.h"
#endif

#ifdef SDI_WITH_NDI
#include "ndi_device.h"
#endif

namespace sdi {

std::unique_ptr<CaptureDevice> make_capture(std::string_view kind) {
#ifdef SDI_WITH_DECKLINK
    if (kind == "decklink") return std::make_unique<DeckLinkDevice>();
#endif
#ifdef SDI_WITH_AJA
    if (kind == "aja") return std::make_unique<AJADevice>();
#endif
#ifdef SDI_WITH_NDI
    if (kind == "ndi") return std::make_unique<NDIDevice>();
#endif
    return nullptr;
}

} // namespace sdi
