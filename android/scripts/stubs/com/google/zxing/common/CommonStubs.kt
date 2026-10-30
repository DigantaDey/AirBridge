package com.google.zxing.common

import com.google.zxing.Binarizer
import com.google.zxing.LuminanceSource

class HybridBinarizer(source: LuminanceSource) : Binarizer(source)

class GlobalHistogramBinarizer(source: LuminanceSource) : Binarizer(source)
