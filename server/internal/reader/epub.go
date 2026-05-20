package reader

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"mime"
	"path"
	"path/filepath"
	"strings"
)

func init() {
	Register(".epub", func() FormatReader { return &epubReader{} })
}

type epubReader struct {
	zr        *zip.ReadCloser
	coverHref string // path inside the zip (already resolved against OPF dir)
	title     string
	spineLen  int
}

type epubContainer struct {
	XMLName   xml.Name `xml:"container"`
	Rootfiles struct {
		Rootfile struct {
			FullPath string `xml:"full-path,attr"`
		} `xml:"rootfile"`
	} `xml:"rootfiles"`
}

type epubMeta struct {
	Name    string `xml:"name,attr"`
	Content string `xml:"content,attr"`
}

type epubManifestItem struct {
	ID         string `xml:"id,attr"`
	Href       string `xml:"href,attr"`
	MediaType  string `xml:"media-type,attr"`
	Properties string `xml:"properties,attr"`
}

type epubItemref struct {
	IDRef string `xml:"idref,attr"`
}

type epubPackage struct {
	XMLName  xml.Name `xml:"package"`
	Metadata struct {
		Title string     `xml:"http://purl.org/dc/elements/1.1/ title"`
		Metas []epubMeta `xml:"meta"`
	} `xml:"metadata"`
	Manifest struct {
		Items []epubManifestItem `xml:"item"`
	} `xml:"manifest"`
	Spine struct {
		Itemrefs []epubItemref `xml:"itemref"`
	} `xml:"spine"`
}

func (r *epubReader) Open(p string) error {
	zr, err := zip.OpenReader(p)
	if err != nil {
		return err
	}
	r.zr = zr

	// 1) container.xml → OPF path
	cf, err := openZipEntry(&zr.Reader, "META-INF/container.xml")
	if err != nil {
		zr.Close()
		return fmt.Errorf("epub: container.xml: %w", err)
	}
	var c epubContainer
	dec := xml.NewDecoder(cf)
	if err := dec.Decode(&c); err != nil {
		cf.Close()
		zr.Close()
		return fmt.Errorf("epub: decode container: %w", err)
	}
	cf.Close()
	opfPath := c.Rootfiles.Rootfile.FullPath
	if opfPath == "" {
		zr.Close()
		return fmt.Errorf("epub: no rootfile")
	}
	opfDir := path.Dir(opfPath)

	// 2) OPF
	of, err := openZipEntry(&zr.Reader, opfPath)
	if err != nil {
		zr.Close()
		return fmt.Errorf("epub: opf: %w", err)
	}
	var pkg epubPackage
	if err := xml.NewDecoder(of).Decode(&pkg); err != nil {
		of.Close()
		zr.Close()
		return fmt.Errorf("epub: decode opf: %w", err)
	}
	of.Close()

	r.title = strings.TrimSpace(pkg.Metadata.Title)
	r.spineLen = len(pkg.Spine.Itemrefs)

	// 3) Find cover. Order of attempts:
	//   - manifest item with properties containing "cover-image" (EPUB 3)
	//   - metadata <meta name="cover" content="id"/> → manifest item by ID (EPUB 2)
	//   - manifest item whose ID contains "cover" and whose media-type is an image
	var coverHref string
	for _, item := range pkg.Manifest.Items {
		if strings.Contains(item.Properties, "cover-image") {
			coverHref = item.Href
			break
		}
	}
	if coverHref == "" {
		var coverID string
		for _, m := range pkg.Metadata.Metas {
			if strings.EqualFold(m.Name, "cover") {
				coverID = m.Content
				break
			}
		}
		if coverID != "" {
			for _, item := range pkg.Manifest.Items {
				if item.ID == coverID {
					coverHref = item.Href
					break
				}
			}
		}
	}
	if coverHref == "" {
		for _, item := range pkg.Manifest.Items {
			if strings.HasPrefix(item.MediaType, "image/") &&
				strings.Contains(strings.ToLower(item.ID), "cover") {
				coverHref = item.Href
				break
			}
		}
	}
	if coverHref != "" {
		// Resolve relative to OPF directory, then clean to handle "../" segments
		r.coverHref = path.Clean(path.Join(opfDir, coverHref))
	}
	return nil
}

// PageCount returns the spine length as a rough estimate. The actual page count
// depends on viewport size and is determined client-side by epub.js.
func (r *epubReader) PageCount() int { return r.spineLen }

// Title exposes the parsed title for metadata extraction.
func (r *epubReader) Title() string { return r.title }

// Page(0) returns the cover image; other pages are rendered client-side.
func (r *epubReader) Page(n int) (io.ReadCloser, string, error) {
	if n != 0 || r.coverHref == "" {
		return nil, "", fmt.Errorf("epub: pages rendered client-side")
	}
	f, err := openZipEntry(&r.zr.Reader, r.coverHref)
	if err != nil {
		return nil, "", err
	}
	data, err := io.ReadAll(f)
	f.Close()
	if err != nil {
		return nil, "", err
	}
	mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(r.coverHref)))
	if mt == "" {
		mt = "image/jpeg"
	}
	return io.NopCloser(bytes.NewReader(data)), mt, nil
}

func (r *epubReader) Close() error {
	if r.zr != nil {
		return r.zr.Close()
	}
	return nil
}

func openZipEntry(z *zip.Reader, name string) (io.ReadCloser, error) {
	// ePub paths inside the zip use forward slashes; normalize for safety.
	target := strings.ReplaceAll(name, "\\", "/")
	for _, f := range z.File {
		if f.Name == target {
			return f.Open()
		}
	}
	// Some ePubs have a leading "./" we should match
	for _, f := range z.File {
		if strings.TrimPrefix(f.Name, "./") == target {
			return f.Open()
		}
	}
	return nil, fmt.Errorf("not found: %s", target)
}
