# To build an xpi of current tree in build/:
# $ make

PWD=`pwd`
XPI="${PWD}/build/JITInspector.xpi"
FILES=\
	LICENSE.txt \
	README.md \
	chrome.manifest \
	content \
	icon.png \
	install.rdf \
	locale \
	skin

.PHONY: xpi

xpi:
	@echo "Building '${XPI}'..."
	@mkdir -p build
	@zip -r ${XPI} ${FILES}
