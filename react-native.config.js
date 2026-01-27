module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import com.meisterwork.otaupdate.OtaUpdatePackage;',
        packageInstance: 'new OtaUpdatePackage()',
      },
      ios: {},
    },
  },
};
